/**
 * Integration test: child-usage sink (Teams lane).
 *
 * Verifies the shared child-usage sink contract
 * (flow/findings/2026-07-17-unify-child-usage/solutions/child-usage-schema-contract.md):
 *  - Sink file materializes at <dir>/<childSessionId>.json after agent_end.
 *  - tokensTotal persisted matches ActivityTracker.get(name).totalTokens.
 *  - turns increment on agent_end; toolCalls increment on tool_execution_end.
 *  - Atomic write: file is always valid JSON, no torn output, no leftover .tmp.
 *  - Idempotent merge preserves foreign fields another writer may have set.
 *  - FS failure is swallowed (non-blocking) — never throws into the runtime.
 *  - schemaVersion=1, source='teams', durationScope='wallclock'.
 *  - Terminal write (worker exit) sets endedAt + durationMs.
 *
 * Usage:
 *   PI_TEAMS_CHILD_USAGE_DIR=<tmpdir> npx tsx scripts/integration-child-usage-sink-test.mts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { ActivityTracker } from "../extensions/teams/activity-tracker.js";
import {
	writeChildUsage,
	getChildUsageDir,
	childSessionIdFromSessionFile,
	type ChildUsageSinkConfig,
} from "../extensions/teams/child-usage-sink.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		passed++;
		console.log(`✓ ${label}`);
		return;
	}
	failed++;
	console.error(`✗ ${label}`);
}

function assertEq<T>(actual: T, expected: T, label: string): void {
	const ok = actual === expected;
	assert(
		ok,
		`${label}${ok ? "" : ` (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`}`,
	);
}

// ── temp sink dir override ────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teams-child-usage-"));
process.env.PI_TEAMS_CHILD_USAGE_DIR = tmpRoot;
assertEq(getChildUsageDir(), tmpRoot, "getChildUsageDir honors PI_TEAMS_CHILD_USAGE_DIR override");

function readRecord(childSessionId: string): Record<string, unknown> | null {
	const fp = path.join(getChildUsageDir(), `${childSessionId}.json`);
	try {
		const raw = fs.readFileSync(fp, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
	return null;
}

// ── childSessionId derivation from session file basename ───────────────────
const sessionFile = `/some/dir/2026-07-17T12-00-00-000Z_019f6b6f-aaaa-bbbb-cccc-ddddeeeeffff.jsonl`;
assertEq(
	childSessionIdFromSessionFile(sessionFile),
	"019f6b6f-aaaa-bbbb-cccc-ddddeeeeffff",
	"childSessionIdFromSessionFile extracts UUID from <ts>_<uuid>.jsonl",
);
assertEq(childSessionIdFromSessionFile(undefined), null, "childSessionIdFromSessionFile returns null when sessionFile missing");

// ── standalone writer: schema correctness ─────────────────────────────────
const childId = "11111111-aaaa-bbbb-cccc-ddddeeeeffff";
const startedAt = "2026-07-17T12:00:00.000Z";
const cfg: ChildUsageSinkConfig = { childSessionId: childId, parentSessionId: "22222222-aaaa-bbbb-cccc-ddddeeeeffff", startedAt };

writeChildUsage(cfg, { tokensTotal: 42, toolCalls: 3, turns: 1 });
const rec1 = readRecord(childId);
assert(rec1 !== null, "sink file materializes after write");
assertEq(rec1?.schemaVersion ?? null, 1, "schemaVersion=1");
assertEq(rec1?.source ?? null, "teams", "source='teams'");
assertEq(rec1?.durationScope ?? null, "wallclock", "durationScope='wallclock'");
assertEq(rec1?.childSessionId ?? null, childId, "childSessionId matches filename");
assertEq(rec1?.parentSessionId ?? null, cfg.parentSessionId, "parentSessionId recorded");
assertEq(rec1?.tokensTotal ?? null, 42, "tokensTotal persisted (absolute)");
assertEq(rec1?.toolCalls ?? null, 3, "toolCalls persisted");
assertEq(rec1?.turns ?? null, 1, "turns persisted");
assertEq(rec1?.startedAt ?? null, startedAt, "startedAt from spawn time");
assertEq(rec1?.endedAt ?? null, null, "endedAt null before terminal write");
assert(typeof rec1?.updatedAt === "string", "updatedAt present (ISO string)");

// ── atomic write: no leftover .tmp, file always valid JSON ─────────────────
assertEq(fs.existsSync(path.join(tmpRoot, `${childId}.json.tmp`)), false, "no leftover .tmp after atomic rename");

// Pre-seed a corrupt main file; write must replace it atomically (no torn JSON on disk).
fs.writeFileSync(path.join(tmpRoot, `${childId}.json`), "{ NOT VALID JSON ");
writeChildUsage(cfg, { tokensTotal: 50, toolCalls: 4, turns: 2 });
const rec2 = readRecord(childId);
assert(rec2 !== null, "atomic write replaces corrupt file with valid JSON");
assertEq(rec2?.tokensTotal ?? null, 50, "merge replaces owned field (tokensTotal) with new absolute value");

// ── idempotent merge preserves foreign fields another writer may have set ──
const foreignRec = {
	schemaVersion: 1,
	childSessionId: childId,
	parentSessionId: cfg.parentSessionId,
	source: "teams",
	tokensTotal: 999, // will be overwritten by Teams
	toolCalls: 999,
	turns: 999,
	durationMs: 0,
	durationScope: "wallclock",
	startedAt,
	updatedAt: "2026-07-17T12:00:01.000Z",
	endedAt: null,
	// foreign / extension fields another sink may have written:
	tokensIn: 1234,
	tokensOut: 5678,
	notes: "from-another-writer",
};
const childIdForeign = "33333333-aaaa-bbbb-cccc-ddddeeeeffff";
const cfgForeign: ChildUsageSinkConfig = { childSessionId: childIdForeign, parentSessionId: cfg.parentSessionId, startedAt };
fs.writeFileSync(path.join(tmpRoot, `${childIdForeign}.json`), JSON.stringify(foreignRec));
writeChildUsage(cfgForeign, { tokensTotal: 100, toolCalls: 5, turns: 3 });
const recF = readRecord(childIdForeign);
assertEq(recF?.tokensTotal ?? null, 100, "merge overwrites Teams-owned tokensTotal");
assertEq(recF?.tokensIn ?? null, 1234, "merge preserves foreign tokensIn");
assertEq(recF?.tokensOut ?? null, 5678, "merge preserves foreign tokensOut");
assertEq(recF?.notes ?? null, "from-another-writer", "merge preserves foreign notes field");

// ── FS failure is swallowed (non-blocking) ────────────────────────────────
// Point the dir at a path where a parent component is a file, so mkdir/write fails.
const blockerFile = path.join(tmpRoot, "blocker-file");
fs.writeFileSync(blockerFile, "x");
const blockedCfg: ChildUsageSinkConfig = {
	childSessionId: "44444444-aaaa-bbbb-cccc-ddddeeeeffff",
	parentSessionId: cfg.parentSessionId,
	startedAt,
};
// Temporarily redirect sink dir under a file path component.
process.env.PI_TEAMS_CHILD_USAGE_DIR = path.join(blockerFile, "child-usage");
let swallowed = true;
try {
	writeChildUsage(blockedCfg, { tokensTotal: 1, toolCalls: 1, turns: 1 });
} catch {
	swallowed = false;
}
assert(swallowed, "FS failure is swallowed (no throw into runtime)");
// restore
process.env.PI_TEAMS_CHILD_USAGE_DIR = tmpRoot;

// ── ActivityTracker integration: agent_end triggers sink write ─────────────
const trackerDir = path.join(tmpRoot, "tracker");
fs.mkdirSync(trackerDir, { recursive: true });
process.env.PI_TEAMS_CHILD_USAGE_DIR = trackerDir;

const tracker = new ActivityTracker();
const workerName = "agent-x";
const workerChildId = "55555555-aaaa-bbbb-cccc-ddddeeeeffff";
const workerStartedAt = "2026-07-17T12:01:00.000Z";
tracker.setChildUsageSink(() => ({
	childSessionId: workerChildId,
	parentSessionId: cfg.parentSessionId,
	startedAt: workerStartedAt,
}));

const messageEndEv: AgentEvent = {
	type: "message_end",
	message: { usage: { totalTokens: 137 } },
} as unknown as AgentEvent;
const toolStartEv: AgentEvent = { type: "tool_execution_start", toolCallId: "c1", toolName: "bash" } as unknown as AgentEvent;
const toolEndEv: AgentEvent = { type: "tool_execution_end", toolCallId: "c1", toolName: "bash" } as unknown as AgentEvent;
const agentEndEv: AgentEvent = { type: "agent_end" } as unknown as AgentEvent;

tracker.handleEvent(workerName, toolStartEv);
tracker.handleEvent(workerName, toolEndEv);
tracker.handleEvent(workerName, messageEndEv);
tracker.handleEvent(workerName, agentEndEv);

const recT1 = readRecord(workerChildId);
assert(recT1 !== null, "sink file appears after agent_end event via ActivityTracker");
assertEq(recT1?.tokensTotal ?? null, 137, "tokensTotal persisted matches ActivityTracker.get(name).totalTokens");
assertEq(recT1?.turns ?? null, 1, "agent_end increments turns in sink");
assertEq(recT1?.toolCalls ?? null, 1, "tool_execution_end increments toolCalls reflected in sink");

// Second turn: tokens accumulate (absolute totals)
tracker.handleEvent(workerName, messageEndEv); // +137
tracker.handleEvent(workerName, agentEndEv);
const recT2 = readRecord(workerChildId);
assertEq(recT2?.tokensTotal ?? null, 274, "tokensTotal is absolute (cumulative across turns)");
assertEq(recT2?.turns ?? null, 2, "second agent_end increments turns");
assertEq(tracker.get(workerName).totalTokens, 274, "ActivityTracker.totalTokens in-memory matches sink (OT6 fixed)");

// ── terminal write (worker exit) sets endedAt + durationMs ─────────────────
tracker.persistTerminal(workerName);
const recT3 = readRecord(workerChildId);
assert(typeof recT3?.endedAt === "string", "terminal write sets endedAt (ISO string)");
assert(typeof recT3?.durationMs === "number" && (recT3?.durationMs ?? -1) >= 0, "terminal write sets durationMs (>=0)");

// ── no sink configured: handleEvent is a no-op (safe default) ──────────────
const trackerNoSink = new ActivityTracker();
trackerNoSink.handleEvent("lonely", messageEndEv);
trackerNoSink.handleEvent("lonely", agentEndEv);
assert(true, "ActivityTracker without sink configured does not throw");

// ── childSessionId unavailable: write skipped (no throw, no file) ───────────
const trackerNoId = new ActivityTracker();
trackerNoId.setChildUsageSink(() => null); // resolver cannot resolve id
trackerNoId.handleEvent("noid", messageEndEv);
trackerNoId.handleEvent("noid", agentEndEv);
const noIdFiles = fs.readdirSync(trackerDir).filter((f) => f.endsWith(".json"));
assert(noIdFiles.every((f) => !f.startsWith("noid")), "no sink file when childSessionId unavailable");

// ── cleanup ────────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failed > 0) {
	console.error(`FAILED: ${failed} assertion(s)`);
	process.exit(1);
}
console.log(`PASSED: ${passed}`);
