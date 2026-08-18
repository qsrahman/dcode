import type { ToolCall, ToolDefinition } from './types.ts'

// A gate decides whether a single tool call may run. Read-only tools are always
// allowed; mutating tools depend on the mode. One-shot runs use the deny gate
// (no interactive approval), the REPL uses the confirm gate (per-call prompt).
export type Gate = (tool: ToolDefinition, call: ToolCall) => Promise<boolean>

export function createDenyGate(): Gate {
  return async (tool) => !tool.mutates
}

export function createAllowGate(): Gate {
  return async () => true
}

// Prompts the user via `ask` for each mutating call. `a` approves every
// remaining call in the session; `y`/`yes` approves one; anything else denies.
export function createConfirmGate(
  ask: (prompt: string) => Promise<string>,
): Gate {
  let alwaysApprove = false
  return async (tool, call) => {
    if (!tool.mutates) return true
    if (alwaysApprove) return true
    const answer = (await ask(confirmPrompt(tool, call))).trim().toLowerCase()
    if (answer === 'a') {
      alwaysApprove = true
      return true
    }
    return answer === 'y' || answer === 'yes'
  }
}

function confirmPrompt(tool: ToolDefinition, call: ToolCall): string {
  return `${tool.name}(${call.arguments}) — approve? [y/n/a] `
}
