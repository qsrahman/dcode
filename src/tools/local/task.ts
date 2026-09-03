import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../../agent/types.ts'
import type { Client, ResponseInput } from '../../agent/client.ts'
import { runAgent } from '../../agent/loop.ts'
import { ContextManager } from '../../agent/context/manager.ts'
import { ToolRegistry } from '../registry.ts'
import { getAgentType } from '../../agent/subagent.ts'
import { TaskStore } from '../../agent/todo-store.ts'
import { todoTool } from './todo.ts'
import type { RunSink } from '../../agent/run.ts'

const MAX_DEPTH = 1

// No-op sink: sub-agent output streams to /dev/null — only the final text is
// returned to the parent.
const silentSink: RunSink = { write() {} }

// taskTool closes over the parent's client and tool registry so the sub-agent
// can reuse the same LLM client and know which tools the parent has available
// (to filter down for the child).
export function taskTool(
  parentClient: Client,
  parentTools: ToolRegistry,
): ToolDefinition {
  return {
    name: 'task',
    parallel: false,
    description: `Launch a new agent to handle complex, multistep tasks autonomously.

When using this task tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Grep tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly
- If no available agent is a good fit for the task, use other tools directly


Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. Once you have delegated work to an agent, do not duplicate that work yourself. Continue with non-overlapping tasks.
3. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
4. Every agent invocation starts with a fresh context; sessions cannot be resumed. Your prompt must be a complete, self-contained task description, and should say exactly what information the agent is to return in its final and only message to you.
5. The agent's outputs should generally be trusted
6. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible (e.g., relevant test commands).
7. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.

Available agent types and the tools they have access to:
- general: Full tools for research and multi-step tasks. Has access to: read_file, list_dir, grep, stat, glob, write_file, edit_file, move_file, copy_file, delete_file, make_dir, run_shell, run_process, read_process, kill_process, web_search, web_fetch, todowrite, ask_user
- explore: Read-only agent for codebase exploration. Has access to: read_file, list_dir, grep, stat, glob, web_search, web_fetch`,
    parameters: z.object({
      description: z
        .string()
        .describe('A short (3-5 words) description of the task'),
      prompt: z.string().describe('The task for the agent to perform'),
      subagent_type: z
        .string()
        .describe('The type of specialized agent to use for this task'),
    }),
    async execute(args: unknown, ctx: ToolContext) {
      return runSubAgent(
        args as {
          description: string
          prompt: string
          subagent_type: string
        },
        ctx,
        parentClient,
        parentTools,
      )
    },
  }
}

async function runSubAgent(
  args: {
    description: string
    prompt: string
    subagent_type: string
  },
  ctx: ToolContext,
  client: Client,
  parentTools: ToolRegistry,
): Promise<string> {
  const depth = ctx.depth ?? 0
  if (depth >= MAX_DEPTH) {
    return wrapResult(
      'error',
      `error: sub-agent nesting limit reached (depth ${depth}). Sub-agents cannot spawn further sub-agents.`,
    )
  }

  const agentType = getAgentType(args.subagent_type)
  if (!agentType) {
    const known = ['general', 'explore'].join(', ')
    return wrapResult(
      'error',
      `error: unknown agent type "${args.subagent_type}". Available types: ${known}`,
    )
  }

  // Filter parent's tools to only those the agent type can use. `todowrite`
  // is rebound to a fresh, per-sub-agent TaskStore rather than reused as-is:
  // the parent's definition closes over the *session's* store, and
  // TaskStore.replace overwrites the whole list, so a sub-agent tracking its
  // own steps would wipe the parent's plan — including the "authoritative
  // task list" compact.ts injects into the compaction summary.
  const childTools = new ToolRegistry(
    parentTools
      .list()
      .filter((t) => agentType.tools.includes(t.name))
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
    const text = await runAgent(client, ctx.config, history, {
      sink: silentSink,
      logger: ctx.logger,
      signal: ctx.signal,
      tools: childTools,
      context,
      depth: depth + 1,
      instructions: agentType.buildPrompt(ctx.config),
    })

    return wrapResult('completed', text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return wrapResult('error', `error: ${msg}`)
  }
}

function wrapResult(state: 'completed' | 'error', body: string): string {
  const tag = state === 'error' ? 'task_error' : 'task_result'
  return [
    `<task state="${state}">`,
    `<${tag}>`,
    body,
    `</${tag}>`,
    '</task>',
  ].join('\n')
}
