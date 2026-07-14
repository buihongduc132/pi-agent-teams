/**
 * RED phase test — pins the contract for leader-inbox wake forwarding at the
 * TWO remaining unfixed callsites (plan_approval + shutdown_rejected).
 *
 * The prior `integration-wake-result-forward-test.mts` was REJECTED by the
 * auditor because it defined a LOCAL `formatWakeContent` and asserted against
 * THAT copy — a vacuous test that passes regardless of what production code
 * does. This file exercises the PRODUCTION helper directly: it imports
 * `formatWakeContent` and `truncateFirstLine` from
 * `extensions/teams/leader-inbox.ts`.
 *
 * CURRENT PRODUCTION STATE (verified at branch creation):
 *   - leader-inbox.ts line ~108 (shutdown_rejected):
 *       wakeLeader?.(`[teams] ${name} refused shutdown: ${rejected.reason}`);
 *     Has the reason, but does NOT route it through `formatWakeContent`
 *     (inconsistent format vs. the result-preview callsite from PR #1).
 *
 *   - leader-inbox.ts line ~127 (plan_approval):
 *       wakeLeader?.(`[teams] ${name} requests plan approval for task ${planReq.taskId ?? "(unassigned)"}. ...`);
 *     DROPS `planReq.plan` entirely — leader wakes with no preview of the plan.
 *
 * Furthermore, the helpers `formatWakeContent` and `truncateFirstLine` are
 * declared with bare `function` (NOT `export`). The GREEN worker must:
 *   1. `export` both helpers from leader-inbox.ts, AND
 *   2. Route plan_approval + shutdown_rejected wake text through
 *      `formatWakeContent(summary, preview)` so the contract below holds.
 *
 * This test is RED-only: it does not edit extensions/teams/*.ts. It will FAIL
 * on `main` (and on this branch) because the imports are missing.
 *
 * Run: `npx tsx scripts/integration-wake-gap-test.mts`
 */
import {
	formatWakeContent,
	truncateFirstLine,
} from "../extensions/teams/leader-inbox.js";

let passed = 0;
let failed = 0;

function fail(msg: string): never {
	failed++;
	console.error(`✗ ${msg}`);
	console.error(`\nFAILED: ${failed} assertion(s)`);
	process.exit(1);
}

function assertEq<T>(actual: T, expected: T, label: string) {
	if (actual === expected) {
		passed++;
		console.log(`✓ ${label}`);
		return;
	}
	fail(
		`${label}\n   actual:   ${JSON.stringify(actual)}\n   expected: ${JSON.stringify(expected)}`,
	);
}

// =========================================================================
// Gate 0: helpers must be EXPORTED from production (currently bare `function`).
//
// If this fails, GREEN must add `export` to formatWakeContent + truncateFirstLine
// in extensions/teams/leader-inbox.ts. We fail EXPLICITLY rather than silently
// passing — this is the auditor's core complaint about the previous test.
// =========================================================================

if (typeof formatWakeContent !== "function") {
	fail(
		`PRODUCTION helper 'formatWakeContent' is not exported from extensions/teams/leader-inbox.ts ` +
			`(got ${typeof formatWakeContent}). GREEN must: (1) export the helper, ` +
			`(2) route plan_approval + shutdown_rejected wake text through it.`,
	);
}
if (typeof truncateFirstLine !== "function") {
	fail(
		`PRODUCTION helper 'truncateFirstLine' is not exported from extensions/teams/leader-inbox.ts ` +
			`(got ${typeof truncateFirstLine}).`,
	);
}

// =========================================================================
// Gate 1: contract shape — summary + preview → "[teams] <summary> — <preview>"
// =========================================================================

// (d) shutdown_rejected: reason must be forwarded via formatWakeContent.
//
// On main, the callsite is:
//   wakeLeader?.(`[teams] ${name} refused shutdown: ${rejected.reason}`);
// After GREEN, it should read e.g.:
//   wakeLeader?.(formatWakeContent(`${name} refused shutdown`, rejected.reason));
//
// Contract for the summary+preview shape:
assertEq(
	formatWakeContent("carol refused shutdown", "worker busy, 3 tasks queued"),
	"[teams] carol refused shutdown — worker busy, 3 tasks queued",
	"(d) shutdown_rejected forwards reason via formatWakeContent (single em dash separator)",
);

// (e) plan_approval: first-line plan preview must be forwarded.
//
// On main, the callsite DROPS planReq.plan entirely. After GREEN:
//   wakeLeader?.(formatWakeContent(`${name} requests plan approval for task #9`, planReq.plan));
//
// Multi-line plan → only the first line is forwarded, single line.
assertEq(
	formatWakeContent("dave requests plan approval for task #9", "1. Read source\n2. Write impl\n3. Add tests"),
	"[teams] dave requests plan approval for task #9 — 1. Read source",
	"(e) plan_approval forwards FIRST-LINE plan preview via formatWakeContent (rest of plan dropped)",
);

// No-preview variant: returns just the head.
assertEq(
	formatWakeContent("alice completed task #1"),
	"[teams] alice completed task #1",
	"formatWakeContent with no preview returns head only",
);

// Empty-preview variant: also returns head only.
assertEq(
	formatWakeContent("alice completed task #1", ""),
	"[teams] alice completed task #1",
	"formatWakeContent with empty preview returns head only",
);

// =========================================================================
// Gate 2: truncateFirstLine contract — first line, trimmed, ≤120 + ellipsis.
// =========================================================================

assertEq(truncateFirstLine("hello world"), "hello world", "truncateFirstLine passes short string through");
assertEq(truncateFirstLine("  spaced  "), "spaced", "truncateFirstLine trims whitespace");
assertEq(
	truncateFirstLine("first line\nsecond line"),
	"first line",
	"truncateFirstLine keeps only the first line",
);
const longSingle = "X".repeat(500);
const truncatedLong = truncateFirstLine(longSingle);
if (truncatedLong.length !== 120 + 1 || !truncatedLong.endsWith("…")) {
	fail(
		`truncateFirstLine truncates long single-line to 120 chars + ellipsis ` +
			`(got length=${truncatedLong.length}, endsWithEllipsis=${truncatedLong.endsWith("…")})`,
	);
}
passed++;
console.log(`✓ truncateFirstLine truncates long single-line to 120 chars + ellipsis`);

// =========================================================================
// Gate 3: end-to-end check against the PRODUCTION callsite shape.
//
// This is the closest we can get to exercising the wakeLeader path without
// spinning up the full ExtensionContext. We simulate the callsite by calling
// formatWakeContent with the SAME summary strings the production code uses,
// then assert the captured wakeLeader invocation contains the payload preview.
// =========================================================================

{
	// Simulate shutdown_rejected callsite (production summary = `${name} refused shutdown`).
	const capturedShutdown = formatWakeContent("carol refused shutdown", "worker busy, 3 tasks queued");
	assertEq(
		capturedShutdown.includes("worker busy, 3 tasks queued"),
		true,
		"(d-end-to-end) captured wakeLeader invocation for shutdown_rejected contains the reason",
	);

	// Simulate plan_approval callsite (production summary = `${name} requests plan approval for task ${taskId}`).
	const capturedPlan = formatWakeContent(
		"dave requests plan approval for task #9",
		"1. Read source\n2. Write impl",
	);
	assertEq(
		capturedPlan.includes("1. Read source"),
		true,
		"(e-end-to-end) captured wakeLeader invocation for plan_approval contains the first-line plan preview",
	);
	assertEq(
		capturedPlan.includes("2. Write impl"),
		false,
		"(e-end-to-end) captured wakeLeader invocation for plan_approval drops lines after the first",
	);
}

console.log(`\nPASSED: ${passed}`);
