import type { AgentDefinition } from "./types.js";

/**
 * Parse agent definition from .md file with YAML frontmatter.
 *
 * Format:
 * ```
 * ---
 * name: reviewer
 * description: Code review specialist
 * tools: read, bash, intercom
 * model: anthropic/claude-sonnet-4
 * thinking: high
 * ---
 * You are a code reviewer...
 * ```
 */
export function parseAgentFrontmatter(content: string, filePath: string): AgentDefinition | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return null;

	const fmText = match[1] ?? "";
	const body = match[2]?.trim() ?? "";

	const fm: Record<string, string> = {};
	for (const rawLine of fmText.split(/\r?\n/)) {
		const line = rawLine;
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			const val = line.slice(idx + 1).trim();
			if (key) fm[key] = val;
		}
	}

	const name = fm.name;
	if (!name) return null;

	let tools: string[] | undefined;
	let mcpTools: string[] | undefined;

	if (fm.tools) {
		const all = fm.tools
			.split(/[,\s]+/)
			.map((t) => t.trim())
			.filter(Boolean);
		tools = all.filter((t) => !t.startsWith("mcp:"));
		mcpTools = all
			.filter((t) => t.startsWith("mcp:"))
			.map((t) => t.slice(4));
	}

	return {
		name,
		description: fm.description || "",
		tools: tools && tools.length > 0 ? tools : undefined,
		mcpTools: mcpTools && mcpTools.length > 0 ? mcpTools : undefined,
		model: fm.model || undefined,
		thinking: fm.thinking || undefined,
		prompt: body,
		filePath,
	};
}

/**
 * Serialize an AgentDefinition back to .md with frontmatter.
 */
export function serializeAgentMarkdown(agent: Omit<AgentDefinition, "filePath">): string {
	const lines: string[] = ["---"];
	lines.push(`name: ${agent.name}`);
	if (agent.description) lines.push(`description: ${agent.description}`);
	const allTools = [...(agent.tools ?? []), ...(agent.mcpTools?.map((t) => `mcp:${t}`) ?? [])];
	if (allTools.length > 0) lines.push(`tools: ${allTools.join(", ")}`);
	if (agent.model) lines.push(`model: ${agent.model}`);
	if (agent.thinking) lines.push(`thinking: ${agent.thinking}`);
	lines.push("---");
	lines.push("");
	lines.push(agent.prompt);
	return lines.join("\n");
}
