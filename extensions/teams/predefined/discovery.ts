/**
 * Discovery of predefined agent definitions and team templates.
 *
 * Looks in both user-scope and project-scope directories.
 * Project scope wins on name collisions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentDefinition, PredefinedTeam } from "./types.js";
import { parseAgentFrontmatter } from "./agent-parser.js";
import { parseTeamsYaml } from "./teams-yaml-parser.js";

function agentsDir(scope: "user" | "project", projectDir?: string): string {
	return scope === "user"
		? path.join(os.homedir(), ".pi", "agent", "agents")
		: path.join(projectDir ?? process.cwd(), ".pi", "agents");
}

function teamsYamlPath(scope: "user" | "project", projectDir?: string): string {
	return scope === "user"
		? path.join(os.homedir(), ".pi", "teams.yaml")
		: path.join(projectDir ?? process.cwd(), ".pi", "teams.yaml");
}

/** Discover all agent .md files in a single directory. */
export function discoverAgents(dir: string): AgentDefinition[] {
	if (!fs.existsSync(dir)) return [];
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => {
				const content = fs.readFileSync(path.join(dir, f), "utf-8");
				return parseAgentFrontmatter(content, path.join(dir, f));
			})
			.filter((a): a is AgentDefinition => a !== null);
	} catch {
		return [];
	}
}

/** Get all agent definitions across user + project scope (project wins on collision). */
export function getAllAgentDefinitions(projectDir?: string): AgentDefinition[] {
	const user = discoverAgents(agentsDir("user"));
	const project = projectDir ? discoverAgents(agentsDir("project", projectDir)) : [];
	const map = new Map(user.map((a) => [a.name, a]));
	for (const a of project) map.set(a.name, a);
	return [...map.values()];
}

/** Look up a single agent definition by name. */
export function getAgentDefinition(name: string, projectDir?: string): AgentDefinition | undefined {
	return getAllAgentDefinitions(projectDir).find((a) => a.name === name);
}

/** Get all predefined team templates across user + project scope. */
export function getAllPredefinedTeams(projectDir?: string): PredefinedTeam[] {
	const teams: PredefinedTeam[] = [];
	for (const scope of ["user", "project"] as const) {
		const yp = teamsYamlPath(scope, projectDir);
		if (fs.existsSync(yp)) {
			try {
				teams.push(...parseTeamsYaml(fs.readFileSync(yp, "utf-8")));
			} catch {
				// skip malformed
			}
		}
	}
	const map = new Map(teams.map((t) => [t.name, t]));
	return [...map.values()];
}

/** Look up a single predefined team by name. */
export function getPredefinedTeam(name: string, projectDir?: string): PredefinedTeam | undefined {
	return getAllPredefinedTeams(projectDir).find((t) => t.name === name);
}

/** Get the user-scope agents directory path. */
export function getUserAgentsDir(): string {
	return agentsDir("user");
}

/** Get the project-scope agents directory path. */
export function getProjectAgentsDir(projectDir?: string): string {
	return agentsDir("project", projectDir);
}

/** Get the user-scope teams.yaml path. */
export function getUserTeamsYamlPath(): string {
	return teamsYamlPath("user");
}

/** Get the project-scope teams.yaml path. */
export function getProjectTeamsYamlPath(projectDir?: string): string {
	return teamsYamlPath("project", projectDir);
}
