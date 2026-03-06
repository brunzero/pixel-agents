import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS, RECENT_ACTIVITY_THRESHOLD_MS, TERMINAL_NAME_PREFIX } from './constants.js';

export function startFileWatching(
	agentId: number,
	filePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	// Primary: fs.watch (unreliable on macOS — may miss events)
	try {
		const watcher = fs.watch(filePath, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
		fileWatchers.set(agentId, watcher);
	} catch (e) {
		console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
	}

	// Secondary: fs.watchFile (stat-based polling, reliable on macOS)
	try {
		fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
	} catch (e) {
		console.log(`[Pixel Agents] fs.watchFile failed for agent ${agentId}: ${e}`);
	}

	// Tertiary: manual poll as last resort
	const interval = setInterval(() => {
		if (!agents.has(agentId)) {
			clearInterval(interval);
			try { fs.unwatchFile(filePath); } catch { /* ignore */ }
			return;
		}
		readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
	}, FILE_WATCHER_POLL_INTERVAL_MS);
	pollingTimers.set(agentId, interval);
}

export function readNewLines(
	agentId: number,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const stat = fs.statSync(agent.jsonlFile);
		if (stat.size <= agent.fileOffset) return;

		const buf = Buffer.alloc(stat.size - agent.fileOffset);
		const fd = fs.openSync(agent.jsonlFile, 'r');
		fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
		fs.closeSync(fd);
		agent.fileOffset = stat.size;

		const text = agent.lineBuffer + buf.toString('utf-8');
		const lines = text.split('\n');
		agent.lineBuffer = lines.pop() || '';

		const hasLines = lines.some(l => l.trim());
		if (hasLines) {
			// New data arriving — cancel timers (data flowing means agent is still active)
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
			}
		}

		for (const line of lines) {
			if (!line.trim()) continue;
			processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
		}
	} catch (e) {
		console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
	}
}

export function ensureProjectScan(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	jsonlPollTimers?: Map<number, ReturnType<typeof setInterval>>,
): void {
	if (projectScanTimerRef.current) {
		console.log(`[Pixel Agents] ensureProjectScan: timer already running, skipping`);
		return;
	}
	// Seed with all existing JSONL files so we only react to truly new ones
	try {
		const files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
		for (const f of files) {
			knownJsonlFiles.add(f);
		}
		console.log(`[Pixel Agents] ensureProjectScan: seeded ${files.length} existing JSONL files`);
	} catch { /* dir may not exist yet */ }

	projectScanTimerRef.current = setInterval(() => {
		scanForNewJsonlFiles(
			projectDir, knownJsonlFiles, activeAgentIdRef, nextAgentIdRef,
			agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, persistAgents, jsonlPollTimers,
		);
	}, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewJsonlFiles(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	jsonlPollTimers?: Map<number, ReturnType<typeof setInterval>>,
): void {
	let files: string[];
	try {
		files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
	} catch { return; }

	const newFiles = files.filter(f => !knownJsonlFiles.has(f));
	if (newFiles.length > 0) {
		console.log(`[Pixel Agents] Scanner: found ${newFiles.length} new JSONL file(s): ${newFiles.map(f => path.basename(f)).join(', ')}, activeAgent=${activeAgentIdRef.current}, agents.size=${agents.size}`);
	}

	for (const file of files) {
		if (!knownJsonlFiles.has(file)) {
			knownJsonlFiles.add(file);
			if (activeAgentIdRef.current !== null) {
				const activeAgent = agents.get(activeAgentIdRef.current);
				// Check if the active agent's JSONL is still being written to recently.
				// If yes, it *might* be a parallel agent — but only if a different terminal
				// created the new file. If the same terminal is active, it's /resume or /clear.
				let oldFileStillActive = false;
				if (activeAgent) {
					try {
						const stat = fs.statSync(activeAgent.jsonlFile);
						oldFileStillActive = (Date.now() - stat.mtimeMs) < RECENT_ACTIVITY_THRESHOLD_MS;
					} catch { /* file may be gone */ }
				}

				const currentTerminal = vscode.window.activeTerminal;
				// Same terminal as active agent → /resume or /clear (reassign, not duplicate)
				// Different terminal + old file active → genuine parallel agent
				if (oldFileStillActive && currentTerminal && currentTerminal !== activeAgent!.terminalRef) {
					// Different terminal — check if it's already tracked by another agent
					let ownerAgentId: number | null = null;
					for (const [id, a] of agents) {
						if (a.terminalRef === currentTerminal) {
							ownerAgentId = id;
							break;
						}
					}
					if (ownerAgentId !== null) {
						// Terminal already tracked — reassign that agent (/resume in a different tracked terminal)
						console.log(`[Pixel Agents] New JSONL detected: ${path.basename(file)}, reassigning agent ${ownerAgentId} (/resume in tracked terminal)`);
						reassignAgentToFile(
							ownerAgentId, file,
							agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
							webview, persistAgents, jsonlPollTimers,
						);
					} else {
						// Untracked terminal — genuine parallel agent
						console.log(`[Pixel Agents] New JSONL detected: ${path.basename(file)}, creating parallel agent (different terminal)`);
						adoptTerminalForFile(
							currentTerminal, file, projectDir,
							nextAgentIdRef, agents, activeAgentIdRef,
							fileWatchers, pollingTimers, waitingTimers, permissionTimers,
							webview, persistAgents,
						);
					}
				} else {
					// Same terminal or old file inactive → reassignment
					console.log(`[Pixel Agents] New JSONL detected: ${path.basename(file)}, reassigning to agent ${activeAgentIdRef.current}`);
					reassignAgentToFile(
						activeAgentIdRef.current, file,
						agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
						webview, persistAgents, jsonlPollTimers,
					);
				}
			} else {
				// No active agent — a new JSONL file appearing is strong evidence Claude
				// is running. Adopt the active terminal (regardless of name — "zsh" etc.
				// can be running Claude). Startup adoption was removed separately since
				// there's no new-file signal at startup.
				const activeTerminal = vscode.window.activeTerminal;
				if (activeTerminal) {
					let owned = false;
					for (const agent of agents.values()) {
						if (agent.terminalRef === activeTerminal) {
							owned = true;
							break;
						}
					}
					if (!owned) {
						console.log(`[Pixel Agents] Scanner: adopting terminal "${activeTerminal.name}" for ${path.basename(file)}`);
						adoptTerminalForFile(
							activeTerminal, file, projectDir,
							nextAgentIdRef, agents, activeAgentIdRef,
							fileWatchers, pollingTimers, waitingTimers, permissionTimers,
							webview, persistAgents,
						);
					}
				}
			}
		}
	}

	// If no agents exist, check for recently-active existing files.
	// This handles Claude reusing an existing JSONL (session resume) where
	// no new file appears on disk.
	if (agents.size === 0) {
		let bestFile: string | null = null;
		let bestMtime = 0;
		for (const f of files) {
			try {
				const stat = fs.statSync(f);
				if (stat.mtimeMs > bestMtime) {
					bestMtime = stat.mtimeMs;
					bestFile = f;
				}
			} catch { /* ignore */ }
		}
		// Only adopt if modified very recently (within 5s) — proof Claude is active NOW
		if (bestFile && (Date.now() - bestMtime) < 5000) {
			const activeTerminal = vscode.window.activeTerminal;
			if (activeTerminal) {
				console.log(`[Pixel Agents] Scanner: active JSONL ${path.basename(bestFile)} (${Math.round((Date.now() - bestMtime) / 1000)}s ago), adopting terminal "${activeTerminal.name}"`);
				adoptTerminalForFile(
					activeTerminal, bestFile, projectDir,
					nextAgentIdRef, agents, activeAgentIdRef,
					fileWatchers, pollingTimers, waitingTimers, permissionTimers,
					webview, persistAgents,
				);
			}
		}
	}
}

/** Check if a terminal looks like it's running Claude Code (not a regular shell). */
function isClaudeLikeTerminal(terminal: vscode.Terminal): boolean {
	const name = terminal.name;
	// Terminals created by pixel-agents: "Claude Code #1", "Claude Code #2", etc.
	if (name.startsWith(TERMINAL_NAME_PREFIX)) return true;
	// External Claude Code terminals use their version as the name (e.g. "2.1.70")
	if (/^\d+\.\d+\.\d+/.test(name)) return true;
	return false;
}

function adoptTerminalForFile(
	terminal: vscode.Terminal,
	jsonlFile: string,
	projectDir: string,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const id = nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		terminalRef: terminal,
		projectDir,
		jsonlFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	console.log(`[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`);
	webview?.postMessage({ type: 'agentCreated', id });

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

export function reassignAgentToFile(
	agentId: number,
	newFilePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	jsonlPollTimers?: Map<number, ReturnType<typeof setInterval>>,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Cancel JSONL poll timer (from launchNewTerminal) to prevent duplicate watchers
	if (jsonlPollTimers) {
		const jpTimer = jsonlPollTimers.get(agentId);
		if (jpTimer) { clearInterval(jpTimer); }
		jsonlPollTimers.delete(agentId);
	}

	// Stop old file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	// Clear activity
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);
	clearAgentActivity(agent, agentId, permissionTimers, webview);

	// Swap to new file
	agent.jsonlFile = newFilePath;
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	persistAgents();

	// Start watching new file
	startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
}
