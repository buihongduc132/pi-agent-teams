/**
 * /team-config — Interactive TUI configuration panel for teams.
 *
 * Uses pi's built-in ctx.ui.select/confirm/input primitives.
 * Vim-style navigation (j/k/arrow keys) is handled by pi's select().
 *
 * Screens:
 *   Main → Agent Definitions / Team Templates / Spawn / Save / Tool Policy
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentDefinition, PredefinedTeam } from "./predefined/types.js";
import {
	getAllAgentDefinitions,
	getAllPredefinedTeams,
	getAgentDefinition,
	getPredefinedTeam,
	getUserAgentsDir,
	getProjectAgentsDir,
	getUserTeamsYamlPath,
	getProjectTeamsYamlPath,
} from "./predefined/discovery.js";
import { serializeAgentMarkdown } from "./predefined/agent-parser.js";
import { parseTeamsYaml, serializeTeamsYaml } from "./predefined/teams-yaml-parser.js";
import { sanitizeName } from "./names.js";

// ── Helpers ──────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeAgentFile(dir: string, agent: Omit<AgentDefinition, "filePath">): string {
	const safe = sanitizeName(agent.name);
	const filePath = path.join(dir, `${safe}.md`);
	fs.writeFileSync(filePath, serializeAgentMarkdown(agent), "utf-8");
	return filePath;
}

function appendTeamToYaml(yamlPath: string, team: PredefinedTeam): void {
	ensureDir(path.dirname(yamlPath));
	const existing = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, "utf-8") : "";
	const teams = parseTeamsYaml(existing);
	const idx = teams.findIndex((t) => t.name === team.name);
	if (idx >= 0) teams[idx] = team;
	else teams.push(team);
	fs.writeFileSync(yamlPath, serializeTeamsYaml(teams), "utf-8");
}

const BACK = "← Back";

// ── Main Entry ───────────────────────────────────────────────────────

export async function runTeamConfigTUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	while (true) {
		const choice = await ctx.ui.select("Team Configuration", [
			"Agent Definitions",
			"Team Templates",
			"Spawn Predefined Team",
			"Tool Policy",
			BACK,
		]);
		if (!choice || choice === BACK) return;

		switch (choice) {
			case "Agent Definitions":
				await agentListScreen(pi, ctx);
				break;
			case "Team Templates":
				await teamListScreen(pi, ctx);
				break;
			case "Spawn Predefined Team":
				await spawnTeamScreen(pi, ctx);
				break;
			case "Tool Policy":
				await toolPolicyScreen(pi, ctx);
				break;
		}
	}
}

// ── Agent Definitions ────────────────────────────────────────────────

async function agentListScreen(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const agents = getAllAgentDefinitions(ctx.cwd);
	const items = agents.map((a) => {
		const tools = a.tools ? a.tools.join(",") : "(inherit)";
		return `${a.name}  [${tools}]`;
	});
	items.push("+ Create New Agent");
	items.push(BACK);

	const choice = await ctx.ui.select("Agent Definitions", items);
	if (!choice || choice === BACK) return;

	if (choice === "+ Create New Agent") {
		await createAgentScreen(pi, ctx);
		return;
	}

	const name = (choice.split("  ")[0] ?? "").trim();
	await agentDetailScreen(pi, ctx, name);
}

async function createAgentScreen(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const name = await ctx.ui.input("Agent name", "worker");
	if (!name) return;

	const tools = await ctx.ui.input("Tools (comma-separated)", "read, bash, edit, write");
	const model = await ctx.ui.input("Model (empty = inherit)", "");
	const thinking = await ctx.ui.input("Thinking (empty = inherit)", "");
	const prompt = await ctx.ui.input("Prompt (one-line)", `You are ${name}.`);

	const scope = await ctx.ui.select("Save to scope", ["user", "project"]);
	if (!scope) return;

	const dir = scope === "user" ? getUserAgentsDir() : getProjectAgentsDir(ctx.cwd);
	ensureDir(dir);
	writeAgentFile(dir, {
		name: sanitizeName(name),
		description: "",
		tools: tools
			? tools
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: undefined,
		model: model || undefined,
		thinking: thinking || undefined,
		prompt: prompt ?? `You are ${name}.`,
	});

	ctx.ui.notify(`Created agent '${name}' in ${dir}`, "info");
}

async function agentDetailScreen(pi: ExtensionAPI, ctx: ExtensionContext, name: string): Promise<void> {
	const agent = getAgentDefinition(name, ctx.cwd);

	const fields = [
		`Name: ${agent?.name ?? name}`,
		`Description: ${agent?.description ?? ""}`,
		`Tools: ${(agent?.tools ?? []).join(", ") || "(inherit)"}`,
		`Model: ${agent?.model ?? "(inherit)"}`,
		`Thinking: ${agent?.thinking ?? "(inherit)"}`,
		"Edit Agent",
		"Delete Agent",
		BACK,
	];

	const choice = await ctx.ui.select(`Agent: ${name}`, fields);
	if (!choice || choice === BACK) return;

	if (choice === "Edit Agent") {
		await editAgentScreen(pi, ctx, name);
		return;
	}

	if (choice === "Delete Agent") {
		const ok = await ctx.ui.confirm(`Delete '${name}'?`, "This removes the agent .md file.");
		if (ok && agent) {
			try {
				fs.unlinkSync(agent.filePath);
				ctx.ui.notify(`Deleted agent '${name}'`, "info");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to delete: ${msg}`, "error");
			}
		}
	}
}

async function editAgentScreen(pi: ExtensionAPI, ctx: ExtensionContext, name: string): Promise<void> {
	const agent = getAgentDefinition(name, ctx.cwd);

	const fieldChoice = await ctx.ui.select(`Edit: ${name}`, [
		"Name",
		"Tools",
		"Model",
		"Thinking",
		"Prompt",
		BACK,
	]);
	if (!fieldChoice || fieldChoice === BACK) return;

	switch (fieldChoice) {
		case "Name": {
			const val = await ctx.ui.input("Agent name", agent?.name);
			if (val && agent) {
				const dir = path.dirname(agent.filePath);
				fs.unlinkSync(agent.filePath);
				writeAgentFile(dir, { ...agent, name: sanitizeName(val) });
				ctx.ui.notify(`Renamed to '${val}'`, "info");
			}
			break;
		}
		case "Tools": {
			const val = await ctx.ui.input("Tools (comma-separated)", (agent?.tools ?? []).join(", "));
			if (val !== undefined && agent) {
				const tools = val
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
				writeAgentFile(path.dirname(agent.filePath), {
					...agent,
					tools: tools.length > 0 ? tools : undefined,
				});
				ctx.ui.notify("Updated tools", "info");
			}
			break;
		}
		case "Model": {
			const val = await ctx.ui.input("Model", agent?.model ?? "");
			if (val !== undefined && agent) {
				writeAgentFile(path.dirname(agent.filePath), {
					...agent,
					model: val || undefined,
				});
				ctx.ui.notify("Updated model", "info");
			}
			break;
		}
		case "Thinking": {
			const val = await ctx.ui.input("Thinking", agent?.thinking ?? "");
			if (val !== undefined && agent) {
				writeAgentFile(path.dirname(agent.filePath), {
					...agent,
					thinking: val || undefined,
				});
				ctx.ui.notify("Updated thinking", "info");
			}
			break;
		}
		case "Prompt": {
			const val = await ctx.ui.input("Prompt (one-line)", agent?.prompt);
			if (val !== undefined && agent) {
				writeAgentFile(path.dirname(agent.filePath), { ...agent, prompt: val });
				ctx.ui.notify("Updated prompt", "info");
			}
			break;
		}
	}
}

// ── Team Templates ───────────────────────────────────────────────────

async function teamListScreen(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const teams = getAllPredefinedTeams(ctx.cwd);
	const items = teams.map((t) => `${t.name}: [${t.agents.join(", ")}]`);
	items.push("+ Create New Team");
	items.push(BACK);

	const choice = await ctx.ui.select("Team Templates", items);
	if (!choice || choice === BACK) return;

	if (choice === "+ Create New Team") {
		await createTeamScreen(pi, ctx);
		return;
	}

	const name = (choice.split(":")[0] ?? "").trim();
	await teamDetailScreen(pi, ctx, name);
}

async function createTeamScreen(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const name = await ctx.ui.input("Team name", "code-review");
	if (!name) return;

	const agentsStr = await ctx.ui.input("Agents (comma-separated)", "worker, reviewer");
	if (!agentsStr) return;

	const scope = await ctx.ui.select("Save to scope", ["user", "project"]);
	if (!scope) return;

	const agents = agentsStr
		.split(",")
		.map((a) => a.trim())
		.filter(Boolean);
	const yamlPath = scope === "user" ? getUserTeamsYamlPath() : getProjectTeamsYamlPath(ctx.cwd);
	appendTeamToYaml(yamlPath, { name: sanitizeName(name), agents });

	ctx.ui.notify(`Created team '${name}' with agents: ${agents.join(", ")}`, "info");
}

async function teamDetailScreen(pi: ExtensionAPI, ctx: ExtensionContext, name: string): Promise<void> {
	const team = getPredefinedTeam(name, ctx.cwd);
	if (!team) {
		ctx.ui.notify(`Team '${name}' not found`, "error");
		return;
	}

	const items = [
		`Agents: ${team.agents.join(", ")}`,
		"Edit Agents",
		"Delete Team",
		BACK,
	];

	const choice = await ctx.ui.select(`Team: ${name}`, items);
	if (!choice || choice === BACK) return;

	if (choice === "Edit Agents") {
		const val = await ctx.ui.input("Agents (comma-separated)", team.agents.join(", "));
		if (val !== undefined) {
			const agents = val
				.split(",")
				.map((a) => a.trim())
				.filter(Boolean);
			// Find which yaml has this team
			for (const yamlPath of [getUserTeamsYamlPath(), getProjectTeamsYamlPath(ctx.cwd)]) {
				if (fs.existsSync(yamlPath)) {
					const teams = parseTeamsYaml(fs.readFileSync(yamlPath, "utf-8"));
					if (teams.find((t) => t.name === name)) {
						const idx = teams.findIndex((t) => t.name === name);
						if (idx >= 0 && teams[idx]) {
							teams[idx].agents = agents;
							fs.writeFileSync(yamlPath, serializeTeamsYaml(teams), "utf-8");
							ctx.ui.notify("Updated team agents", "info");
						}
						break;
					}
				}
			}
		}
	}

	if (choice === "Delete Team") {
		const ok = await ctx.ui.confirm(`Delete team '${name}'?`, "This removes it from teams.yaml.");
		if (ok) {
			for (const yamlPath of [getUserTeamsYamlPath(), getProjectTeamsYamlPath(ctx.cwd)]) {
				if (fs.existsSync(yamlPath)) {
					const teams = parseTeamsYaml(fs.readFileSync(yamlPath, "utf-8"));
					const idx = teams.findIndex((t) => t.name === name);
					if (idx >= 0) {
						teams.splice(idx, 1);
						fs.writeFileSync(yamlPath, serializeTeamsYaml(teams), "utf-8");
						ctx.ui.notify(`Deleted team '${name}'`, "info");
						break;
					}
				}
			}
		}
	}
}

// ── Spawn Predefined Team ────────────────────────────────────────────

async function spawnTeamScreen(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const teams = getAllPredefinedTeams(ctx.cwd);
	if (teams.length === 0) {
		ctx.ui.notify("No predefined teams. Create ~/.pi/teams.yaml or .pi/teams.yaml first.", "warning");
		return;
	}

	const items = teams.map((t) => `${t.name} [${t.agents.join(", ")}]`);
	items.push(BACK);

	const choice = await ctx.ui.select("Spawn Team", items);
	if (!choice || choice === BACK) return;

	const teamName = (choice.split(" [")[0] ?? "").trim();
	// Note: We use sendUserMessage because /team-config runs as a command handler
	// without access to spawnTeammate(). The LLM will use the teams tool to spawn.
	// This is intentional — commands are lightweight, spawn is heavy.
	pi.sendUserMessage(`Spawn predefined team '${teamName}' using the teams tool with action=predefined_team_spawn.`);
}

// ── Tool Policy ──────────────────────────────────────────────────────

async function toolPolicyScreen(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const policyPath = path.join(os.homedir(), ".pi", "agent", "teams-tool-policy.json");
	let policy: { baseline?: string[]; denied?: string[]; extra?: string[] } = {};
	try {
		if (fs.existsSync(policyPath)) policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
	} catch {
		// use defaults
	}

	const defaults = {
		baseline: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		denied: [] as string[],
		extra: ["hindsight_search", "hindsight_context", "hindsight_retain", "hindsight_bank_profile"],
	};

	const effective = {
		baseline: policy.baseline ?? defaults.baseline,
		denied: policy.denied ?? defaults.denied,
		extra: policy.extra ?? defaults.extra,
	};

	while (true) {
		const choice = await ctx.ui.select("Tool Policy", [
			`Baseline: ${effective.baseline.join(", ")}`,
			`Denied: ${effective.denied.join(", ") || "(none)"}`,
			`Extra: ${effective.extra.join(", ")}`,
			"Save",
			BACK,
		]);
		if (!choice || choice === BACK) return;

		if (choice.startsWith("Baseline:")) {
			const val = await ctx.ui.input("Baseline tools (comma-separated)", effective.baseline.join(", "));
			if (val !== undefined) {
				effective.baseline = val
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
			}
		}
		if (choice.startsWith("Denied:")) {
			const val = await ctx.ui.input("Denied tools (comma-separated)", effective.denied.join(", "));
			if (val !== undefined) {
				effective.denied = val
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
			}
		}
		if (choice.startsWith("Extra:")) {
			const val = await ctx.ui.input("Extra tools (comma-separated)", effective.extra.join(", "));
			if (val !== undefined) {
				effective.extra = val
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
			}
		}
		if (choice === "Save") {
			ensureDir(path.dirname(policyPath));
			fs.writeFileSync(
				policyPath,
				JSON.stringify(
					{
						baseline: effective.baseline,
						denied: effective.denied,
						extra: effective.extra,
					},
					null,
					2,
				) + "\n",
				"utf-8",
			);
			ctx.ui.notify(`Tool policy saved to ${policyPath}`, "info");
			return;
		}
	}
}
