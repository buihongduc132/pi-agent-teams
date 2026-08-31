/**
 * child-usage-sink.ts — shared child-usage sink writer (Teams lane).
 *
 * Implements the canonical contract:
 *   flow/findings/2026-07-17-unify-child-usage/solutions/child-usage-schema-contract.md
 *
 * Writes one JSON object per worker session to:
 *   <agentDir>/child-usage/<childSessionId>.json
 *
 * Write semantics:
 *   - Atomic: write <file>.tmp then rename (readers never see torn JSON).
 *   - Idempotent merge: read existing, replace only fields Teams owns; never
 *     null-out fields another writer may have set.
 *   - Absolute totals: caller computes the new total before writing.
 *   - Non-blocking: any FS failure is debug-logged and swallowed. Usage
 *     tracking MUST NOT break the sub-agent runtime (AGENTS.md hook
 *     exception-safety rule).
 *
 * `source: "teams"` disambiguates origin from the ACP lane.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/** Single JSON object written to the sink file. Mirrors the shared contract. */
export interface ChildUsageRecord {
	// ── identity ──
	schemaVersion: number;
	childSessionId: string;
	parentSessionId: string | null;
	source: "teams";

	// ── usage aggregate ──
	tokensTotal: number;
	toolCalls: number;
	turns: number;

	// ── duration ──
	durationMs: number;
	durationScope: "wallclock";

	// ── lifecycle timestamps (ISO 8601 UTC) ──
	startedAt: string | null;
	updatedAt: string;
	endedAt: string | null;
}

/** Identity context the leader resolves per worker before each write. */
export interface ChildUsageSinkConfig {
	childSessionId: string;
	parentSessionId: string | null;
	/** ISO 8601 timestamp of worker spawn (used for startedAt + durationMs). */
	startedAt: string;
}

/** Owned fields Teams may overwrite during a merge. Other fields are preserved. */
export interface ChildUsageOwnedFields {
	tokensTotal?: number;
	toolCalls?: number;
	turns?: number;
	durationMs?: number;
	endedAt?: string | null;
}

const SCHEMA_VERSION = 1;
const SINK_DIR_NAME = "child-usage";
const SOURCE_TAG = "teams" as const;

function debugLog(msg: string): void {
	// Bypass console.* so the no-console lint rule stays clean. Non-blocking.
	try {
		process.stderr.write(`[pi-agent-teams] ${msg}\n`);
	} catch {
		// swallow — debug logging must never throw
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isString(v: unknown): v is string {
	return typeof v === "string";
}

function isNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * Directory holding all child-usage sink files.
 *
 * Default: `${getAgentDir()}/child-usage`
 * Override: `PI_TEAMS_CHILD_USAGE_DIR` (absolute path, or relative to agent dir).
 */
export function getChildUsageDir(): string {
	const override = process.env.PI_TEAMS_CHILD_USAGE_DIR;
	if (override && override.trim()) {
		const p = override.trim();
		return path.isAbsolute(p) ? p : path.join(getAgentDir(), p);
	}
	return path.join(getAgentDir(), SINK_DIR_NAME);
}

/** Full path for a given child session id. */
export function getChildUsageFilePath(childSessionId: string): string {
	return path.join(getChildUsageDir(), `${childSessionId}.json`);
}

/**
 * Derive a stable per-spawn `childSessionId` from a worker's pi session file.
 *
 * Pi session files are named `<timestamp>_<uuid>.jsonl`; the UUID is the
 * session id. If the basename does not match the expected shape we fall back
 * to the final `_`-separated segment (or the full stem), and finally to null
 * when no session file is known (write is skipped per contract).
 */
export function childSessionIdFromSessionFile(sessionFile: string | undefined): string | null {
	if (!sessionFile) return null;
	const base = path.basename(sessionFile);
	// <timestamp>_<uuid>.jsonl
	const match = base.match(/^[^_]+_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/);
	if (match && match[1]) return match[1];
	// Fallback: last underscore segment before extension.
	const noExt = base.replace(/\.[^.]+$/, "");
	const parts = noExt.split("_");
	const last = parts[parts.length - 1];
	if (last && last.length > 0) return last;
	return noExt.length > 0 ? noExt : null;
}

function readExisting(filePath: string): Record<string, unknown> {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (isRecord(parsed)) return parsed;
	} catch {
		// missing or corrupt — start from empty, atomic write will replace.
	}
	return {};
}

function pickNumber(existing: Record<string, unknown>, key: string, fallback: number): number {
	const v = existing[key];
	return isNumber(v) ? v : fallback;
}

function pickString(existing: Record<string, unknown>, key: string, fallback: string | null): string | null {
	const v = existing[key];
	return isString(v) ? v : fallback;
}

/**
 * Atomically write (merge) child-usage fields for the given worker session.
 *
 * Never throws. FS failures are debug-logged and swallowed.
 */
export function writeChildUsage(
	cfg: ChildUsageSinkConfig,
	owned: ChildUsageOwnedFields,
	now: number = Date.now(),
): void {
	const dir = getChildUsageDir();
	const filePath = path.join(dir, `${cfg.childSessionId}.json`);
	const tmpPath = `${filePath}.tmp`;
	try {
		fs.mkdirSync(dir, { recursive: true });
		const existing = readExisting(filePath);

		// Merge: identity + owned fields are Teams-controlled; foreign keys preserved.
		const merged: ChildUsageRecord = {
			schemaVersion: SCHEMA_VERSION,
			childSessionId: cfg.childSessionId,
			parentSessionId: pickString(existing, "parentSessionId", cfg.parentSessionId),
			source: SOURCE_TAG,
			tokensTotal: owned.tokensTotal ?? pickNumber(existing, "tokensTotal", 0),
			toolCalls: owned.toolCalls ?? pickNumber(existing, "toolCalls", 0),
			turns: owned.turns ?? pickNumber(existing, "turns", 0),
			durationMs: owned.durationMs ?? pickNumber(existing, "durationMs", 0),
			durationScope: "wallclock",
			startedAt: pickString(existing, "startedAt", cfg.startedAt),
			updatedAt: new Date(now).toISOString(),
			endedAt: owned.endedAt !== undefined ? owned.endedAt : pickString(existing, "endedAt", null),
		};

		// Preserve foreign keys not part of the canonical schema.
		const foreign: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(existing)) {
			if (!Object.prototype.hasOwnProperty.call(merged, k)) {
				foreign[k] = v;
			}
		}
		const out: Record<string, unknown> = { ...foreign, ...merged };

		fs.writeFileSync(tmpPath, `${JSON.stringify(out, null, 2)}\n`);
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		// Non-blocking: debug-log + swallow. Never break the worker runtime.
		debugLog(`child-usage sink write failed for ${cfg.childSessionId}: ${err instanceof Error ? err.message : String(err)}`);
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// tmp already gone — fine.
		}
	}
}
