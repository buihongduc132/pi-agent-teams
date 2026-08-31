import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
	writeChildUsage,
	type ChildUsageOwnedFields,
	type ChildUsageSinkConfig,
} from "./child-usage-sink.js";

// ── Transcript types ──

export type TranscriptEntry =
	| { kind: "text"; text: string; timestamp: number }
	| { kind: "tool_start"; toolName: string; timestamp: number }
	| { kind: "tool_end"; toolName: string; durationMs: number; timestamp: number }
	| { kind: "turn_end"; turnNumber: number; tokens: number; timestamp: number };

const MAX_TRANSCRIPT = 200;

export class TranscriptLog {
	private entries: TranscriptEntry[] = [];

	push(entry: TranscriptEntry): void {
		this.entries.push(entry);
		if (this.entries.length > MAX_TRANSCRIPT) {
			this.entries.splice(0, this.entries.length - MAX_TRANSCRIPT);
		}
	}

	getEntries(): readonly TranscriptEntry[] {
		return this.entries;
	}

	get length(): number {
		return this.entries.length;
	}

	reset(): void {
		this.entries = [];
	}
}

export class TranscriptTracker {
	private logs = new Map<string, TranscriptLog>();
	private toolStarts = new Map<string, Map<string, number>>(); // name -> toolCallId -> startTimestamp
	private pendingText = new Map<string, string>(); // name -> accumulated text
	private turnCounts = new Map<string, number>();
	private lastTokens = new Map<string, number>(); // name -> tokens from last message_end

	handleEvent(name: string, ev: AgentEvent): void {
		const log = this.getOrCreate(name);
		const now = Date.now();

		if (ev.type === "message_update") {
			const ame = ev.assistantMessageEvent;
			if (ame.type === "text_delta") {
				const cur = this.pendingText.get(name) ?? "";
				this.pendingText.set(name, cur + ame.delta);
				// Flush complete lines
				this.flushText(name, log, now, false);
			}
			return;
		}

		if (ev.type === "tool_execution_start") {
			// Flush any pending text before a tool starts
			this.flushText(name, log, now, true);
			const starts = this.toolStarts.get(name) ?? new Map<string, number>();
			starts.set(ev.toolCallId, now);
			this.toolStarts.set(name, starts);
			log.push({ kind: "tool_start", toolName: ev.toolName, timestamp: now });
			return;
		}

		if (ev.type === "tool_execution_end") {
			const starts = this.toolStarts.get(name);
			const startTs = starts?.get(ev.toolCallId);
			const durationMs = startTs === undefined ? 0 : now - startTs;
			starts?.delete(ev.toolCallId);
			log.push({ kind: "tool_end", toolName: ev.toolName, durationMs, timestamp: now });
			return;
		}

		if (ev.type === "message_end") {
			// Capture tokens for use in the turn_end entry
			const msg: unknown = ev.message;
			if (isRecord(msg)) {
				const usage = msg.usage;
				if (isRecord(usage) && typeof usage.totalTokens === "number") {
					this.lastTokens.set(name, (this.lastTokens.get(name) ?? 0) + usage.totalTokens);
				}
			}
			return;
		}

		if (ev.type === "agent_end") {
			// Flush remaining text
			this.flushText(name, log, now, true);
			const turn = (this.turnCounts.get(name) ?? 0) + 1;
			this.turnCounts.set(name, turn);
			const tokens = this.lastTokens.get(name) ?? 0;
			log.push({ kind: "turn_end", turnNumber: turn, tokens, timestamp: now });
			this.lastTokens.set(name, 0);
			return;
		}
	}

	get(name: string): TranscriptLog {
		return this.logs.get(name) ?? new TranscriptLog();
	}

	reset(name: string): void {
		this.logs.delete(name);
		this.toolStarts.delete(name);
		this.pendingText.delete(name);
		this.turnCounts.delete(name);
		this.lastTokens.delete(name);
	}

	private getOrCreate(name: string): TranscriptLog {
		const existing = this.logs.get(name);
		if (existing) return existing;
		const created = new TranscriptLog();
		this.logs.set(name, created);
		return created;
	}

	private flushText(name: string, log: TranscriptLog, timestamp: number, force: boolean): void {
		const buf = this.pendingText.get(name);
		if (!buf) return;

		// Split into lines; keep the last incomplete line unless forced
		const parts = buf.split("\n");
		if (force) {
			// Flush everything
			for (const part of parts) {
				const trimmed = part.trimEnd();
				if (trimmed) log.push({ kind: "text", text: trimmed, timestamp });
			}
			this.pendingText.delete(name);
		} else if (parts.length > 1) {
			// Flush all complete lines, keep the last (potentially incomplete) part
			for (let i = 0; i < parts.length - 1; i++) {
				const part = parts[i];
				if (part === undefined) continue;
				const trimmed = part.trimEnd();
				if (trimmed) log.push({ kind: "text", text: trimmed, timestamp });
			}
			this.pendingText.set(name, parts[parts.length - 1] ?? "");
		}
	}
}

// ── Activity types ──

type TrackedEventType = "tool_execution_start" | "tool_execution_end" | "agent_end" | "message_end";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export interface TeammateActivity {
	toolUseCount: number;
	currentToolName: string | null;
	lastToolName: string | null;
	turnCount: number;
	totalTokens: number;
	recentEvents: Array<{ type: TrackedEventType; toolName?: string; timestamp: number }>;
}

const MAX_RECENT = 10;

function emptyActivity(): TeammateActivity {
	return {
		toolUseCount: 0,
		currentToolName: null,
		lastToolName: null,
		turnCount: 0,
		totalTokens: 0,
		recentEvents: [],
	};
}

/** Resolves per-worker sink identity; returns null to skip the write. */
export type ChildUsageSinkResolver = (name: string) => ChildUsageSinkConfig | null;

export class ActivityTracker {
	private data = new Map<string, TeammateActivity>();
	private sinkResolver: ChildUsageSinkResolver | null = null;

	/**
	 * Register a child-usage sink resolver. When set, {@link handleEvent}
	 * persists current totals on each `agent_end` (turn boundary) and
	 * {@link persistTerminal} writes terminal lifecycle fields on worker exit.
	 *
	 * Safe to leave unset: handleEvent/persistTerminal become no-ops.
	 */
	setChildUsageSink(resolver: ChildUsageSinkResolver): void {
		this.sinkResolver = resolver;
	}

	/** Persist current totals to the sink (called on agent_end). Never throws. */
	private persistToSink(name: string): void {
		if (!this.sinkResolver) return;
		try {
			const cfg = this.sinkResolver(name);
			if (!cfg) return;
			const a = this.data.get(name);
			if (!a) return;
			const owned: ChildUsageOwnedFields = {
				tokensTotal: a.totalTokens,
				toolCalls: a.toolUseCount,
				turns: a.turnCount,
			};
			writeChildUsage(cfg, owned);
		} catch (err) {
			// Non-blocking: debug-log + swallow. Never break the runtime.
			try {
				process.stderr.write(
					`[pi-agent-teams] child-usage sink persist error: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			} catch {
				// swallow
			}
		}
	}

	/**
	 * Write terminal lifecycle fields (endedAt + durationMs) for a worker.
	 * Must be called BEFORE {@link reset} so in-memory totals are still present.
	 * Never throws.
	 */
	persistTerminal(name: string): void {
		if (!this.sinkResolver) return;
		try {
			const cfg = this.sinkResolver(name);
			if (!cfg) return;
			const a = this.data.get(name);
			const now = Date.now();
			const startedMs = Date.parse(cfg.startedAt);
			const durationMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0;
			const owned: ChildUsageOwnedFields = {
				tokensTotal: a?.totalTokens ?? 0,
				toolCalls: a?.toolUseCount ?? 0,
				turns: a?.turnCount ?? 0,
				durationMs,
				endedAt: new Date(now).toISOString(),
			};
			writeChildUsage(cfg, owned, now);
		} catch (err) {
			try {
				process.stderr.write(
					`[pi-agent-teams] child-usage sink terminal write error: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			} catch {
				// swallow
			}
		}
	}

	handleEvent(name: string, ev: AgentEvent): void {
		const a = this.getOrCreate(name);
		const now = Date.now();

		if (ev.type === "tool_execution_start") {
			a.currentToolName = ev.toolName;
			a.recentEvents.push({ type: ev.type, toolName: ev.toolName, timestamp: now });
			if (a.recentEvents.length > MAX_RECENT) a.recentEvents.shift();
			return;
		}

		if (ev.type === "tool_execution_end") {
			const toolName = a.currentToolName ?? ev.toolName;
			a.toolUseCount++;
			a.lastToolName = toolName;
			a.currentToolName = null;
			a.recentEvents.push({ type: ev.type, toolName, timestamp: now });
			if (a.recentEvents.length > MAX_RECENT) a.recentEvents.shift();
			return;
		}

		if (ev.type === "agent_end") {
			a.turnCount++;
			a.recentEvents.push({ type: ev.type, timestamp: now });
			if (a.recentEvents.length > MAX_RECENT) a.recentEvents.shift();
			this.persistToSink(name);
			return;
		}

		if (ev.type === "message_end") {
			const msg: unknown = ev.message;
			if (!isRecord(msg)) return;
			const usage = msg.usage;
			if (!isRecord(usage)) return;
			const totalTokens = usage.totalTokens;
			if (typeof totalTokens === "number") a.totalTokens += totalTokens;
		}
	}

	get(name: string): TeammateActivity {
		return this.data.get(name) ?? emptyActivity();
	}

	reset(name: string): void {
		this.data.delete(name);
	}

	private getOrCreate(name: string): TeammateActivity {
		const existing = this.data.get(name);
		if (existing) return existing;

		const created = emptyActivity();
		this.data.set(name, created);
		return created;
	}
}
