import { buildSystemPrompt } from './system.ts'
import type { Config } from '../config/schema.ts'

export interface AgentType {
  name: string
  description: string
  tools: readonly string[]
  buildPrompt: (config: Config) => string
}

// Read-only tools for the explore agent — grep, glob, read, list, web search.
// Matches the names used in src/tools/index.ts and src/tools/local/*.ts.
const EXPLORE_TOOLS = [
  'read_file',
  'list_dir',
  'grep',
  'stat',
  'glob',
  'web_search',
  'web_fetch',
] as const

// All tools except task itself — the general agent gets full access but cannot
// spawn sub-agents (depth limit enforced in task.ts).
const GENERAL_TOOLS = [
  'read_file',
  'list_dir',
  'grep',
  'stat',
  'glob',
  'write_file',
  'edit_file',
  'move_file',
  'copy_file',
  'delete_file',
  'make_dir',
  'run_shell',
  'run_process',
  'read_process',
  'kill_process',
  'web_search',
  'web_fetch',
  'todowrite',
  'ask_user',
] as const

const EXPLORE_PROMPT = `You are a fast, focused code exploration agent. Your job is to investigate the codebase and return precise, actionable findings.

## Capabilities
- Search files by name (glob) and content (grep)
- Read files and list directories
- Search the web for documentation

## Constraints
- You are READ-ONLY. Do not modify, write, create, or delete any files.
- Do not run shell commands.
- Do not track tasks or manage state.

## Output
- Return only the facts the caller needs. No preamble, no summary fluff.
- Include file paths and line numbers for code references.
- If the answer is long, lead with the most relevant finding.`

export const AGENT_TYPES: Record<string, AgentType> = {
  general: {
    name: 'general',
    description:
      'General-purpose agent for researching complex questions and executing multi-step tasks. Use this when you need to delegate work to a sub-agent.',
    tools: GENERAL_TOOLS,
    buildPrompt: (config) => buildSystemPrompt(config),
  },
  explore: {
    name: 'explore',
    description:
      'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns, search code for keywords, or answer questions about the codebase.',
    tools: EXPLORE_TOOLS,
    buildPrompt: () => EXPLORE_PROMPT,
  },
}

export function getAgentType(name: string): AgentType | undefined {
  return AGENT_TYPES[name]
}

export function listAgentTypes(): AgentType[] {
  return Object.values(AGENT_TYPES)
}

// The agent-type names as a non-empty tuple, so the task tool can build a
// `z.enum` from them: an unknown subagent_type is then rejected by schema
// validation with the valid names listed, instead of reaching execute() and
// coming back as a hand-written error string.
export const AGENT_TYPE_NAMES = Object.keys(AGENT_TYPES) as [
  string,
  ...string[],
]

// Agent-type tool allow-lists are matched against the registry by name, so a
// name that matches nothing removes that tool from every sub-agent silently —
// no error, just a capability that quietly isn't there (this is exactly how
// `list_directory` shipped for a tool actually called `list_dir`). Callers
// hand over the names the registry really has; anything unmatched is a
// programming error in AGENT_TYPES, not a runtime condition.
export function unknownAgentTools(registered: Iterable<string>): string[] {
  const known = new Set(registered)
  const missing = new Set<string>()
  for (const agent of listAgentTypes()) {
    for (const name of agent.tools) {
      if (!known.has(name)) missing.add(`${agent.name}:${name}`)
    }
  }
  return [...missing].sort()
}

// One-line-per-type summary for the task tool's description. Generated from
// AGENT_TYPES rather than hand-written beside it: a hand-maintained copy is
// how the tool description came to advertise a `list_directory` tool that
// doesn't exist, while the filter below silently matched nothing.
export function describeAgentTypes(): string {
  return listAgentTypes()
    .map((a) => `- ${a.name}: ${a.description} Tools: ${a.tools.join(', ')}`)
    .join('\n')
}
