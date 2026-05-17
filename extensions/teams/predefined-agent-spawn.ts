/**
 * Build SpawnTeammateOptions overrides from a predefined agent definition.
 *
 * The caller passes these into spawnTeammate() which applies them
 * in the spawn pipeline (tools, system prompt, model, thinking).
 */
import type { AgentDefinition } from "./predefined/types.js";
import type { SpawnTeammateOptions } from "./spawn-types.js";

/**
 * Build spawn options from a predefined agent definition.
 *
 * Returns a partial SpawnTeammateOptions that the caller merges
 * with any CLI/user overrides (user overrides win).
 */
export function buildPredefinedSpawnOptions(
	agent: AgentDefinition,
	defaults: {
		model?: string;
		thinking?: SpawnTeammateOptions["thinking"];
	},
): SpawnTeammateOptions {
	// Build tool list from agent definition
	const tools: string[] = [];
	if (agent.tools) {
		tools.push(...agent.tools);
	}
	if (agent.mcpTools) {
		for (const t of agent.mcpTools) {
			tools.push(`mcp:${t}`);
		}
	}

	return {
		name: agent.name,
		model: agent.model ?? defaults.model,
		thinking: agent.thinking
			? (agent.thinking as SpawnTeammateOptions["thinking"])
			: defaults.thinking,
		tools: tools.length > 0 ? tools : undefined,
		systemPromptAppend: agent.prompt || undefined,
	};
}
