import { buildSystemPrompt } from './system.ts'
import type { Config } from '../config/schema.ts'

// Which of the parent's tools an agent type may use. `allow` names them
// explicitly; `deny` takes everything the parent has except the named ones.
// The two are not interchangeable: an allow-list has to be edited whenever a
// tool is added, and forgetting silently leaves sub-agents less capable than
// their own description claims — a deny-list stays correct on its own. Use
// `allow` only where the restriction is the point (explore is read-only, and
// must not gain write access just because a new writing tool appeared).
export type ToolPolicy =
  { readonly allow: readonly string[] } | { readonly deny: readonly string[] }

export interface AgentType {
  name: string
  description: string
  tools: ToolPolicy
  buildPrompt: (config: Config) => string
}

// Resolve a policy against the tools the parent actually has, preserving the
// registry's order.
export function resolveAgentTools(
  policy: ToolPolicy,
  registered: readonly string[],
): string[] {
  if ('allow' in policy) {
    const allowed = new Set(policy.allow)
    return registered.filter((name) => allowed.has(name))
  }
  const denied = new Set(policy.deny)
  return registered.filter((name) => !denied.has(name))
}

// Read-only tools for the explore agent — grep, glob, read (which also lists a
// directory), web search. Matches the names used in src/tools/index.ts and
// src/tools/local/*.ts.
const EXPLORE_TOOLS = [
  'read_file',
  'grep',
  'glob',
  'web_search',
  'web_fetch',
] as const

// The general agent gets everything the parent has except `task` itself:
// sub-agents don't spawn sub-agents (the depth limit in task.ts enforces that
// independently). Expressed as a deny-list so it stays literally true as
// tools come and go, rather than as a copy of the registry that
// silently rots the first time someone adds a tool and doesn't update it.
const GENERAL_TOOLS = { deny: ['task'] } as const

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
    // `task` is denied by GENERAL_TOOLS and rejected again by task.ts's
    // MAX_DEPTH even if it weren't, so the base prompt's Sub-agents section
    // (instructions to delegate via `task`) would be dead — and misleading —
    // guidance for this role. Omit it rather than let a general sub-agent be
    // told to do something it structurally cannot do.
    buildPrompt: () => buildSystemPrompt({ subagents: false }),
  },
  explore: {
    name: 'explore',
    description:
      'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns, search code for keywords, or answer questions about the codebase.',
    tools: { allow: EXPLORE_TOOLS },
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

// Policy names are matched against the registry by name, so a name that
// matches nothing quietly does nothing — an allow-list entry removes that
// tool from the agent with no error at all (exactly how `list_directory`
// shipped for a tool actually called `list_dir`), and a deny-list entry fails
// to deny anything. Callers hand over the names the registry really has;
// anything unmatched is a programming error in AGENT_TYPES.
export function unknownAgentTools(registered: Iterable<string>): string[] {
  const known = new Set(registered)
  const missing = new Set<string>()
  for (const agent of listAgentTypes()) {
    const names = 'allow' in agent.tools ? agent.tools.allow : agent.tools.deny
    for (const name of names) {
      if (!known.has(name)) missing.add(`${agent.name}:${name}`)
    }
  }
  return [...missing].sort()
}

// One-line-per-type summary for the task tool's description, resolved against
// the tools the parent actually holds. Generated rather than written by hand
// beside AGENT_TYPES: a hand-maintained copy is how the tool description came
// to advertise a `list_directory` tool that doesn't exist, while the filter
// silently matched nothing.
export function describeAgentTypes(registered: readonly string[]): string {
  return listAgentTypes()
    .map(
      (a) =>
        `- ${a.name}: ${a.description} Tools: ${resolveAgentTools(a.tools, registered).join(', ')}`,
    )
    .join('\n')
}
