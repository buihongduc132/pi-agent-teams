/**
 * RED phase test — pins the contract for leader-inbox wake message content.
 *
 * Currently `extensions/teams/protocol.ts::isIdleNotification` returns
 * `{ from, timestamp, completedTaskId, completedStatus, failureReason }` —
 * there is NO `result` field. Leader-inbox wake calls do not forward any
 * preview of the result, failure reason, shutdown-reject reason, or plan.
 *
 * This test MUST FAIL on (a) in RED. Cases (b)-(e) pin the EXPECTED
 * post-change wake format via the local `formatWakeContent` test-double,
 * which GREEN must reproduce in `extensions/teams/leader-inbox.ts`.
 *
 * Run: `npx tsx scripts/integration-wake-result-forward-test.mts`
 */
import { isIdleNotification, isShutdownRejected, isPlanApprovalRequest } from "../extensions/teams/protocol.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
	if (condition) {
		passed++;
		console.log(`✓ ${label}`);
		return;
	}
	failed++;
	console.error(`✗ ${label}`);
}

function assertEq<T>(actual: T, expected: T, label: string) {
	assert(
		actual === expected,
		`${label}${actual === expected ? "" : ` (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`}`,
	);
}

// --- Contract: post-change leader-inbox wake format ---
//
// GREEN worker MUST make `wakeLeader(...)` callsites in leader-inbox.ts
// produce output equivalent to this helper. The shape is:
//
//   "[teams] <summary> — <preview>"
//
// where <preview> is the first line of the forwarded payload (result /
// failureReason / shutdown reason / plan text), trimmed and truncated to
// MAX_PREVIEW chars. Single line, single em dash separator.
//
// GREEN does NOT need to import this helper — it just needs to produce
// matching output. Defining the contract here lets us assert against it.

const MAX_PREVIEW = 120;

function truncatePreview(s: string, max: number = MAX_PREVIEW): string {
	const firstLine = (s.split(/\r?\n/, 1)[0] ?? "").trim();
	if (firstLine.length <= max) return firstLine;
	return firstLine.slice(0, max) + "…";
}

function formatWakeContent(opts: { summary: string; preview?: string }): string {
	const head = `[teams] ${opts.summary}`;
	if (opts.preview === undefined || opts.preview === "") return head;
	return `${head} — ${truncatePreview(opts.preview)}`;
}

// =========================================================================
// (a) isIdleNotification forwards a `result` field — currently MISSING.
// =========================================================================

const idlePayloadA = JSON.stringify({
	type: "idle_notification",
	from: "alice",
	timestamp: "2026-07-14T00:00:00Z",
	completedTaskId: "42",
	completedStatus: "completed",
	result: "Fixed bug X in leader-inbox.ts",
});

const idleA = isIdleNotification(idlePayloadA);
assert(idleA !== null, "isIdleNotification parses idle_notification");
const idleAResult = (idleA as { result?: string } | null)?.result;
assertEq(
	idleAResult,
	"Fixed bug X in leader-inbox.ts",
	"isIdleNotification forwards 'result' field from payload",
);

// =========================================================================
// (b) completed + result → wake content includes truncated result preview.
// =========================================================================

const idlePayloadB = JSON.stringify({
	type: "idle_notification",
	from: "alice",
	timestamp: "2026-07-14T00:00:01Z",
	completedTaskId: "42",
	completedStatus: "completed",
	result: "Fixed bug X in leader-inbox.ts",
});

const idleB = isIdleNotification(idlePayloadB);
assert(idleB !== null, "(b) isIdleNotification parses completed idle payload");
const idleBResult = (idleB as { result?: string } | null)?.result;
const wakeB = formatWakeContent({
	summary: "alice completed task #42",
	preview: idleBResult,
});
assert(
	wakeB.includes("Fixed bug X in leader-inbox.ts"),
	`(b) wake for completed task forwards result preview (wake=${JSON.stringify(wakeB)})`,
);

// =========================================================================
// (c) failed + failureReason → wake content includes reason preview.
// =========================================================================

const idlePayloadC = JSON.stringify({
	type: "idle_notification",
	from: "bob",
	timestamp: "2026-07-14T00:00:02Z",
	completedTaskId: "7",
	completedStatus: "failed",
	failureReason: "timeout exceeded 30s",
});

const idleC = isIdleNotification(idlePayloadC);
assert(idleC !== null, "(c) isIdleNotification parses failed idle payload");
const wakeC = formatWakeContent({
	summary: "bob FAILED task #7",
	preview: idleC?.failureReason,
});
assert(
	wakeC.includes("timeout exceeded 30s"),
	`(c) wake for failed task forwards failureReason preview (wake=${JSON.stringify(wakeC)})`,
);

// =========================================================================
// (d) shutdown_rejected + reason → wake content includes reason.
// =========================================================================

const rejPayload = JSON.stringify({
	type: "shutdown_rejected",
	from: "carol",
	requestId: "req-1",
	reason: "worker busy, 3 tasks queued",
	timestamp: "2026-07-14T00:00:03Z",
});

const rej = isShutdownRejected(rejPayload);
assert(rej !== null, "(d) isShutdownRejected parses payload");
assertEq(rej?.reason, "worker busy, 3 tasks queued", "(d) isShutdownRejected forwards reason");
const wakeD = formatWakeContent({
	summary: "carol refused shutdown",
	preview: rej?.reason,
});
assert(
	wakeD.includes("worker busy, 3 tasks queued"),
	`(d) wake for shutdown_rejected forwards reason preview (wake=${JSON.stringify(wakeD)})`,
);

// =========================================================================
// (e) plan_approval_request + plan → wake content includes truncated plan
//     preview (first line, ≤120 chars).
// =========================================================================

const planPayload = JSON.stringify({
	type: "plan_approval_request",
	from: "dave",
	requestId: "req-2",
	taskId: "9",
	plan: "1. Read source\n2. Write impl\n3. Add tests",
	timestamp: "2026-07-14T00:00:04Z",
});

const plan = isPlanApprovalRequest(planPayload);
assert(plan !== null, "(e) isPlanApprovalRequest parses payload");
const wakeE = formatWakeContent({
	summary: "dave requests plan approval for task #9",
	preview: plan?.plan,
});
assert(
	wakeE.includes("1. Read source"),
	`(e) wake for plan_approval forwards first-line plan preview (wake=${JSON.stringify(wakeE)})`,
);
assert(
	!wakeE.includes("2. Write impl"),
	`(e) wake for plan_approval only includes first line of multi-line plan (wake=${JSON.stringify(wakeE)})`,
);

// =========================================================================
// Truncation contract: very long single-line result is truncated with ellipsis.
// =========================================================================

const longResult = "X".repeat(500);
const wakeLong = formatWakeContent({ summary: "alice completed task #99", preview: longResult });
assert(
	wakeLong.length <= `[teams] alice completed task #99 — `.length + MAX_PREVIEW + 1,
	`(truncation) long preview capped at ${MAX_PREVIEW} chars + ellipsis (wake length=${wakeLong.length})`,
);
assert(wakeLong.endsWith("…"), "(truncation) long preview ends with ellipsis");

if (failed > 0) {
	console.error(`FAILED: ${failed} assertion(s)`);
	process.exit(1);
}

console.log(`PASSED: ${passed}`);
