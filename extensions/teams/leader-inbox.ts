import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { popUnreadMessages, writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import {
	TEAM_MAILBOX_NS,
	isIdleNotification,
	isPeerDmSent,
	isPlanApprovalRequest,
	isShutdownApproved,
	isShutdownRejected,
} from "./protocol.js";
import { ensureTeamConfig, setMemberStatus, upsertMember } from "./team-config.js";
import { getTask } from "./task-store.js";

import { shouldWakeLeaderOnAllEvents, type TeamsHookInvocation } from "./hooks.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";

const WAKE_PREVIEW_MAX = 120;

/**
 * Extract the first line of `s`, trim it, and truncate to `max` chars with an
 * ellipsis if longer. Mirrors the leader-inbox wake-content contract pinned by
 * `scripts/integration-wake-result-forward-test.mts`.
 */
function truncateFirstLine(s: string, max: number = WAKE_PREVIEW_MAX): string {
	const firstLine = (s.split(/\r?\n/, 1)[0] ?? "").trim();
	if (firstLine.length <= max) return firstLine;
	return firstLine.slice(0, max) + "…";
}

/**
 * Build a single-line wake message: `[teams] <summary>` optionally followed by
 * ` — <truncated preview>`. Matches the contract pinned by the integration
 * test so leader wake content is consistent across event types.
 */
function formatWakeContent(summary: string, preview?: string): string {
	const head = `[teams] ${summary}`;
	if (!preview) return head;
	const truncated = truncateFirstLine(preview);
	if (!truncated) return head;
	return `${head} — ${truncated}`;
}

export async function pollLeaderInbox(opts: {
	ctx: ExtensionContext;
	teamId: string;
	teamDir: string;
	taskListId: string;
	leadName: string;
	style: TeamsStyle;
	pendingPlanApprovals: Map<string, { requestId: string; name: string; taskId?: string }>;
	enqueueHook?: (invocation: TeamsHookInvocation) => void;
	/** Optional: wake the leader LLM by injecting a user-visible message (triggers a new turn). */
	wakeLeader?: (message: string) => void;
}): Promise<number> {
	const { ctx, teamId, teamDir, taskListId, leadName, style, pendingPlanApprovals, enqueueHook, wakeLeader } = opts;
	const strings = getTeamsStrings(style);

	let msgs: Awaited<ReturnType<typeof popUnreadMessages>>;
	try {
		msgs = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, leadName);
	} catch (err: unknown) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
		return 0;
	}
	if (!msgs.length) return 0;

	let processed = 0;
	for (const m of msgs) {
		processed += 1;
		const approved = isShutdownApproved(m.text);
		if (approved) {
			const name = sanitizeName(approved.from);
			const cfg = await ensureTeamConfig(teamDir, {
				teamId,
				taskListId,
				leadName,
				style,
			});
			if (!cfg.members.some((mm) => mm.name === name)) {
				await upsertMember(teamDir, { name, role: "worker", status: "offline" });
			}
			await setMemberStatus(teamDir, name, "offline", {
				lastSeenAt: approved.timestamp,
				meta: {
					shutdownApprovedRequestId: approved.requestId,
					shutdownApprovedAt: approved.timestamp ?? new Date().toISOString(),
				},
			});
			ctx.ui.notify(`${formatMemberDisplayName(style, name)} ${strings.shutdownCompletedVerb}`, "info");
			if (shouldWakeLeaderOnAllEvents()) {
				wakeLeader?.(`[teams] ${name} shut down successfully.`);
			}
			continue;
		}

		const rejected = isShutdownRejected(m.text);
		if (rejected) {
			const name = sanitizeName(rejected.from);
			await setMemberStatus(teamDir, name, "online", {
				lastSeenAt: rejected.timestamp,
				meta: {
					shutdownRejectedAt: rejected.timestamp ?? new Date().toISOString(),
					shutdownRejectedReason: rejected.reason,
				},
			});
			ctx.ui.notify(`${formatMemberDisplayName(style, name)} ${strings.shutdownRefusedVerb}: ${rejected.reason}`, "warning");
			if (shouldWakeLeaderOnAllEvents()) {
				wakeLeader?.(`[teams] ${name} refused shutdown: ${rejected.reason}`);
			}
			continue;
		}

		const planReq = isPlanApprovalRequest(m.text);
		if (planReq) {
			const name = sanitizeName(planReq.from);
			const preview = planReq.plan.length > 500 ? planReq.plan.slice(0, 500) + "..." : planReq.plan;
			ctx.ui.notify(`${formatMemberDisplayName(style, name)} requests plan approval:\n${preview}`, "info");
			pendingPlanApprovals.set(name, {
				requestId: planReq.requestId,
				name,
				taskId: planReq.taskId,
			});
			if (shouldWakeLeaderOnAllEvents()) {
				wakeLeader?.(`[teams] ${name} requests plan approval for task ${planReq.taskId ?? "(unassigned)"}. Review and approve/reject via teams tool.`);
			}
			continue;
		}

		const peerDm = isPeerDmSent(m.text);
		if (peerDm) {
			ctx.ui.notify(`${peerDm.from} → ${peerDm.to}: ${peerDm.summary}`, "info");
			if (shouldWakeLeaderOnAllEvents()) {
				wakeLeader?.(`[teams] ${peerDm.from} sent a message to ${peerDm.to}: ${peerDm.summary}`);
			}
			continue;
		}

		const idle = isIdleNotification(m.text);
		if (idle) {
			const name = sanitizeName(idle.from);

			// Hook: always emit "idle" (best-effort, non-blocking)
			try {
				enqueueHook?.({
					event: "idle",
					teamId,
					teamDir,
					taskListId,
					style,
					memberName: name,
					timestamp: idle.timestamp,
					completedTask: null,
				});
			} catch {
				// ignore hook enqueue errors
			}

			// Hook: task completion / failure
			if (idle.completedTaskId) {
				const completedTask = await getTask(teamDir, taskListId, idle.completedTaskId);
				try {
					enqueueHook?.({
						event: idle.completedStatus === "failed" ? "task_failed" : "task_completed",
						teamId,
						teamDir,
						taskListId,
						style,
						memberName: name,
						timestamp: idle.timestamp,
						completedTask,
					});
				} catch {
					// ignore hook enqueue errors
				}
			}

			if (idle.failureReason) {
				const cfg = await ensureTeamConfig(teamDir, {
					teamId,
					taskListId,
					leadName,
					style,
				});
				if (!cfg.members.some((mm) => mm.name === name)) {
					await upsertMember(teamDir, { name, role: "worker", status: "offline" });
				}
				await setMemberStatus(teamDir, name, "offline", {
					lastSeenAt: idle.timestamp,
					meta: { offlineReason: idle.failureReason },
				});
				ctx.ui.notify(`${name} went offline (${idle.failureReason})`, "warning");
			} else {
				const desiredSessionName = `pi agent teams - ${strings.memberTitle.toLowerCase()} ${name}`;

				const cfg = await ensureTeamConfig(teamDir, {
					teamId,
					taskListId,
					leadName,
					style,
				});

				const member = cfg.members.find((mm) => mm.name === name);
				const existingSessionNameRaw = member?.meta?.["sessionName"];
				const existingSessionName = typeof existingSessionNameRaw === "string" ? existingSessionNameRaw : undefined;
				const shouldSendName = existingSessionName !== desiredSessionName;

				if (!member) {
					// Manual tmux worker: learn from idle notifications.
					await upsertMember(teamDir, {
						name,
						role: "worker",
						status: "online",
						lastSeenAt: idle.timestamp,
						meta: { sessionName: desiredSessionName },
					});
				} else {
					await setMemberStatus(teamDir, name, "online", {
						lastSeenAt: idle.timestamp,
						meta: { sessionName: desiredSessionName },
					});
				}

				if (shouldSendName) {
					try {
						const ts = new Date().toISOString();
						await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
							from: leadName,
							text: JSON.stringify({
								type: "set_session_name",
								name: desiredSessionName,
								from: leadName,
								timestamp: ts,
							}),
							timestamp: ts,
						});
					} catch {
						// ignore
					}
				}

				if (idle.completedTaskId && idle.completedStatus === "failed") {
					ctx.ui.notify(`${name} aborted task #${idle.completedTaskId}`, "warning");
					wakeLeader?.(
						formatWakeContent(
							`${name} FAILED task #${idle.completedTaskId}. Check team results and remediate.`,
							idle.failureReason,
						),
					);
				} else if (idle.completedTaskId) {
					ctx.ui.notify(`${name} completed task #${idle.completedTaskId}`, "info");
					wakeLeader?.(
						formatWakeContent(`${name} completed task #${idle.completedTaskId}`, idle.result),
					);
				} else {
					ctx.ui.notify(`${name} is idle`, "info");
					if (shouldWakeLeaderOnAllEvents()) {
						wakeLeader?.(`[teams] ${name} is idle and available for work.`);
					}
				}
			}
			continue;
		}

		ctx.ui.notify(`Message from ${m.from}: ${m.text}`, "info");
		if (shouldWakeLeaderOnAllEvents()) {
			const preview = m.text.length > 200 ? m.text.slice(0, 200) + "..." : m.text;
			wakeLeader?.(`[teams] Message from ${m.from}: ${preview}`);
		}
	}

	return processed;
}
