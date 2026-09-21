import { z } from 'zod/v4'
import type { ToolContext } from '../../agent/types.ts'
import type { Client, ResponseInput } from '../../agent/client.ts'
import { runAgent } from '../../agent/loop.ts'
import { ContextManager } from '../../agent/context/manager.ts'
import { ToolRegistry, defineTool } from '../registry.ts'
import {
  getAgentType,
  resolveAgentTools,
  AGENT_TYPE_NAMES,
  describeAgentTypes,
} from '../../agent/subagent.ts'
import { TaskStore } from '../../agent/types.ts'
import { errorMessage } from '../../util/log.ts'
import { todoTool } from './todo.ts'
import type { RunSink } from '../../ui/sink.ts'

const MAX_DEPTH = 1

// No-op sink: sub-agent output streams to /dev/null — only the final text is
// returned to the parent.
const silentSink: RunSink = { write() {} }

// subAgentTool closes over the parent's client and tool registry so the sub-agent
// can reuse the same LLM client and know which tools the parent has available
// (to filter down for the child).
const subAgentParameters = z.object({
  description: z.string().describe('A short (3-5 words) label for the job'),
  prompt: z
    .string()
    .describe(
      'Complete instructions for the sub-agent, including what to return',
    ),
  subagent_type: z.enum(AGENT_TYPE_NAMES).describe('Which agent type to use'),
})

type SubAgentArgs = z.infer<typeof subAgentParameters>

export const subAgentTool = (parentClient: Client, parentTools: ToolRegistry) =>
  defineTool({
    name: 'sub_agent',
    category: 'plan',
    parallel: false,
    description: `Delegate a self-contained job to a sub-agent. It works in its own fresh context and returns only its final message, so its searching and reading stay out of yours. Use it for a broad codebase search or a multi-step job you don't need to watch. Don't use it to read a known file or look up a known symbol; call read_file, glob or grep directly.

Sub-agents run one at a time, can't spawn sub-agents, and can't be resumed, so the prompt must be complete: say exactly what to return, and whether the sub-agent may change code or should only research. The result is not shown to the user; report what matters from it yourself, and treat a result that says it stopped early as incomplete.

Agent types and their tools:
${describeAgentTypes(parentTools.list().map((t) => t.name))}`,
    parameters: subAgentParameters,
    async execute(args, ctx) {
      return runSubAgent(args, ctx, parentClient, parentTools)
    },
  })

async function runSubAgent(
  args: SubAgentArgs,
  ctx: ToolContext,
  client: Client,
  parentTools: ToolRegistry,
): Promise<string> {
  const depth = ctx.depth ?? 0
  if (depth >= MAX_DEPTH) {
    return wrapResult(
      args,
      'error',
      `error: sub-agent nesting limit reached (depth ${depth}). Sub-agents cannot spawn further sub-agents.`,
    )
  }

  // The zod enum already rejects an unknown subagent_type before execute()
  // runs; this only narrows the lookup's `undefined` for the type checker.
  const agentType = getAgentType(args.subagent_type)
  if (!agentType) {
    return wrapResult(
      args,
      'error',
      `error: unknown agent type "${args.subagent_type}"`,
    )
  }

  // Filter parent's tools to only those the agent type can use. `todowrite`
  // is rebound to a fresh, per-sub-agent TaskStore rather than reused as-is:
  // the parent's definition closes over the *session's* store, and
  // TaskStore.replace overwrites the whole list, so a sub-agent tracking its
  // own steps would wipe the parent's plan — including the "authoritative
  // task list" compact.ts injects into the compaction summary.
  const allowed = new Set(
    resolveAgentTools(
      agentType.tools,
      parentTools.list().map((t) => t.name),
    ),
  )
  const childTools = new ToolRegistry(
    parentTools
      .list()
      .filter((t) => allowed.has(t.name))
      .map((t) => (t.name === 'todowrite' ? todoTool(new TaskStore()) : t)),
  )

  // Sub-agents get their own context manager with compaction disabled — they
  // are short-lived workers, not long-running sessions.
  const context = new ContextManager(
    { ...ctx.config.context, auto: false },
    ctx.logger,
  )

  const history: ResponseInput = [{ role: 'user', content: args.prompt }]

  try {
    const { text, truncated } = await runAgent(client, ctx.config, history, {
      sink: silentSink,
      logger: ctx.logger,
      signal: ctx.signal,
      tools: childTools,
      context,
      depth: depth + 1,
      instructions: agentType.buildPrompt(ctx.config),
    })

    // Sub-agent sessions are never resumable (module comment above), so a
    // sub-agent hitting maxToolIterations is a dead end for it specifically
    // — unlike the REPL, there's no follow-up prompt the parent can send to
    // continue it. Flag that in the result body so the parent model treats
    // it as incomplete rather than trusting it the way usage note 5 says to.
    const body = truncated
      ? `${text}\n\n(sub-agent stopped after ${ctx.config.maxToolIterations} tool iterations with work still in progress — treat this result as incomplete)`
      : text

    return wrapResult(args, 'completed', body)
  } catch (err) {
    return wrapResult(args, 'error', `error: ${errorMessage(err)}`)
  }
}

// The model's own `description` is echoed back on the wrapper so a result can
// be matched to the delegation that produced it — otherwise the field would
// be accepted and silently discarded, which is what made `task_id` misleading.
function wrapResult(
  args: SubAgentArgs,
  state: 'completed' | 'error',
  body: string,
): string {
  const tag = state === 'error' ? 'sub_agent_error' : 'sub_agent_result'
  return [
    `<sub_agent state="${state}" description="${args.description}" agent="${args.subagent_type}">`,
    `<${tag}>`,
    body,
    `</${tag}>`,
    '</sub_agent>',
  ].join('\n')
}
