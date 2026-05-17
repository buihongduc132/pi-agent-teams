/**
 * Types for predefined team/agent definitions.
 *
 * Agent definitions live in:
 *   User scope:    ~/.pi/agent/agents/*.md
 *   Project scope: .pi/agents/*.md
 *
 * Team templates live in:
 *   User scope:    ~/.pi/teams.yaml
 *   Project scope: .pi/teams.yaml
 */

/** A single agent definition parsed from an .md file with frontmatter. */
export interface AgentDefinition {
	name: string;
	description: string;
	/** Explicit tool allowlist. Undefined = inherit leader's builtInToolSet. */
	tools?: string[];
	/** MCP tool names (without mcp: prefix). Undefined = inherit MCP tools. */
	mcpTools?: string[];
	/** Model override. Undefined = inherit leader's model. */
	model?: string;
	/** Thinking level override. Undefined = inherit leader's thinking. */
	thinking?: string;
	/** Full prompt body (everything after frontmatter). */
	prompt: string;
	/** Absolute file path of the .md definition. */
	filePath: string;
}

/** A predefined team template parsed from teams.yaml. */
export interface PredefinedTeam {
	/** Team template name (the key in teams.yaml). */
	name: string;
	/** Ordered list of agent definition names to spawn. */
	agents: string[];
	/** Optional human-readable description. */
	description?: string;
}

/** Tool policy for team workers. */
export interface ToolPolicy {
	/** Tools every worker gets by default. */
	baseline: string[];
	/** Tools no worker may ever have. */
	denied: string[];
	/** Extra tools added on top of baseline. */
	extra: string[];
}
