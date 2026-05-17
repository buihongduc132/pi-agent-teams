import type { PredefinedTeam } from "./types.js";

/**
 * Parse teams.yaml into PredefinedTeam[].
 *
 * Expected format (simple YAML mapping of team name → agent list):
 *
 * ```yaml
 * # Optional comments
 * code-review:
 *   - reviewer
 *   - scout
 *
 * full-stack:
 *   - worker
 *   - reviewer
 *   - architect
 * ```
 */
export function parseTeamsYaml(content: string): PredefinedTeam[] {
	const teams: PredefinedTeam[] = [];
	const lines = content.split(/\r?\n/);
	let current: PredefinedTeam | null = null;

	for (const raw of lines) {
		// Strip comments (but not inside strings — we have no strings)
		const line = raw.replace(/#.*$/, "").trimEnd();
		if (!line) continue;

		// Top-level key (team name)
		const topMatch = line.match(/^([\w-]+)\s*:\s*$/);
		if (topMatch && topMatch[1]) {
			if (current) teams.push(current);
			current = { name: topMatch[1], agents: [] };
			continue;
		}

		// Agent entry (indented list item)
		const agentMatch = line.match(/^\s+-\s+([\w-]+)/);
		if (agentMatch && agentMatch[1] && current) {
			current.agents.push(agentMatch[1]);
		}
	}

	if (current) teams.push(current);
	return teams;
}

/**
 * Serialize PredefinedTeam[] back to YAML format.
 */
export function serializeTeamsYaml(teams: PredefinedTeam[]): string {
	const lines: string[] = [];
	for (const team of teams) {
		lines.push(`${team.name}:`);
		for (const agent of team.agents) {
			lines.push(`  - ${agent}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}
