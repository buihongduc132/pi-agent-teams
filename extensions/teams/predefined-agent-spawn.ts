/**
 * Build spawn arguments from a predefined agent definition.
 *
 * This module takes an AgentDefinition (from .md file) and produces
 * the spawn args that get merged into the teammate spawn pipeline.
 * It does NOT spawn directly — the caller (leader.ts) uses these
 * to augment the existing spawnTeammate() flow.
 */
import type { AgentDefinition } from "./predefined/types.js";

export interface PredefinedSpawnOverrides {
	/** Extra tools to add to the built-in set. */
	extraTools: string[];
	/** Extra MCP tools to add (mcp: prefix will be prepended). */
	extraMcpTools: string[];
	/** Model override from agent definition. */
	model?: string;
	/** Thinking level override from agent definition. */
	thinking?: string;
	/** System prompt append from agent definition. */
	systemPromptAppend: string;
}

/**
 * Extract spawn overrides from an AgentDefinition.
 *
 * These are merged INTO the existing spawn pipeline —
 * the caller adds extraTools/extraMcpTools to the builtInToolSet,
 * applies model/thinking overrides, and appends the system prompt.
 */
export function getPredefinedSpawnOverrides(agent: AgentDefinition): PredefinedSpawnOverrides {
	return {
		extraTools: agent.tools ?? [],
		extraMcpTools: agent.mcpTools ?? [],
		model: agent.model,
		thinking: agent.thinking,
		systemPromptAppend: agent.prompt,
	};
}
