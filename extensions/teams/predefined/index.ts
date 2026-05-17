/**
 * Predefined teams/agents module.
 *
 * Provides parsing, discovery, and serialization for:
 * - Agent .md definitions (frontmatter + prompt)
 * - teams.yaml team templates
 */
export type { AgentDefinition, PredefinedTeam } from "./types.js";
export { parseAgentFrontmatter, serializeAgentMarkdown } from "./agent-parser.js";
export { parseTeamsYaml, serializeTeamsYaml } from "./teams-yaml-parser.js";
export {
	discoverAgents,
	getAllAgentDefinitions,
	getAgentDefinition,
	getAllPredefinedTeams,
	getPredefinedTeam,
	getUserAgentsDir,
	getProjectAgentsDir,
	getUserTeamsYamlPath,
	getProjectTeamsYamlPath,
} from "./discovery.js";
