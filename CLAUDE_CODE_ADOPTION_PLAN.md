# CLAUDE_CODE_ADOPTION_PLAN.md — Phased adoption of Claude Code patterns into dcode

Derived from a comprehensive analysis of `tanbiralam/claude-code` (commit
`6f6f12b`) vs dcode's current architecture. Ordered by value/effort ratio.
Each phase lands as code + tests + docs + a focused commit, matching dcode's
existing workflow.

Status: **Draft** — not yet started.

---

## Phase ordering

| Phase | Scope | Effort | Value |
|-------|-------|--------|-------|
| A1 | Cost tracking (`/cost`) | Small | High |
| A2 | Model fallback | Small | High |
| A3 | Max output tokens recovery | Small | High |
| A4 | Tool definition enrichment | Small | Medium |
| A5 | History persistence + `/resume` | Medium | High |
| A6 | Streaming tool execution | Medium | High |
| A7 | Reactive compaction (multi-retry) | Small | Medium |
| A8 | Skills system (model-invocable prompts) | Medium | Medium |
| A9 | Hooks system (pre/post tool-use) | Medium | Medium |
| A10 | Plugin system | Large | Medium |

Phases A1-A4 are independent and can be done in any order. A5-A10 depend on
earlier phases where noted.

---

## A1. Cost tracking

**Goal:** Show cumulative token usage and estimated USD cost per session.

**What Claude Code does:**
- `src/cost-tracker.ts`: tracks input/output tokens per model, computes USD
  cost from a hardcoded pricing table, persists across session resume.
- `/cost` command shows per-model breakdown + total.
- FPS (frames-per-second) metrics for streaming performance.

**What dcode should do:**

### Schema (`config/schema.ts`)
No new config fields needed.

### Module: `agent/cost.ts` (new)
```ts
interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number  // from usage.prompt_tokens_details.cached_tokens
}

interface CostTracker {
  record(model: string, usage: { input_tokens: number; output_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }): void
  total(): { inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  byModel(): Map<string, ModelUsage>
  reset(): void
}
```

Pricing table (hardcoded, updateable):
```ts
const MODEL_PRICING: Record<string, { inputPerToken: number; outputPerToken: number }> = {
  'gpt-5.4-mini': { inputPerToken: 0.40 / 1_000_000, outputPerToken: 1.60 / 1_000_000 },
  'gpt-4.1-mini': { inputPerToken: 0.40 / 1_000_000, outputPerToken: 1.60 / 1_000_000 },
  // fallback: $0 for unknown models
}
```

### Wire into agent loop (`agent/loop.ts`)
After each `runTurn`, call `tracker.record(response.model, response.usage)`.
The tracker lives on the session (same lifetime as `ContextManager`).

### REPL command (`cli/commands.ts`)
`/cost` — print formatted breakdown:
```
Model         Input      Output     Cost
gpt-5.4-mini  12,340     4,560      $0.0122
Total                   16,900      $0.0122
```

### Tests (`tests/agent/cost.test.ts`)
- Record usage, verify totals.
- Unknown model gets $0 cost.
- Reset clears everything.
- Multiple models tracked separately.

### Files touched
- New: `src/agent/cost.ts`, `tests/agent/cost.test.ts`
- Modify: `src/agent/loop.ts` (record after each turn), `src/cli/repl.ts` (create tracker per session), `src/cli/commands.ts` (`/cost` dispatch)

---

## A2. Model fallback

**Goal:** If the primary model fails (429, 500, timeout), retry with a fallback
model before giving up.

**What Claude Code does:**
- `FallbackTriggeredError` thrown when primary fails; caught in `query.ts`,
  which retries with the fallback model.
- `trywitchothermodels` utility function.

**What dcode should do:**

### Schema (`config/schema.ts`)
```ts
fallbackModel: z.string().optional(),  // e.g. 'gpt-4.1-mini'
```

### Changes to `agent/client.ts`
Add a `createFallbackClient(config)` that wraps `createClient` with fallback
logic. Or simpler: let the loop handle it.

### Changes to `agent/loop.ts`
In `runOnce`'s catch block (where `isContextOverflowError` is handled), add:
```ts
if (isRetryableError(err) && config.fallbackModel) {
  const fallbackConfig = { ...config, model: config.fallbackModel }
  const fallbackClient = createClient(fallbackConfig)
  // retry with fallback
}
```

`isRetryableError`: 429 (rate limit), 500/502/503 (server errors), timeouts.
NOT: 400 (bad request), 401 (auth), 403 (forbidden), context overflow (handled
separately).

### Tests (`tests/agent/loop.test.ts`)
- Primary fails with 429, fallback succeeds.
- Primary fails with 400, no fallback (bad request is not retryable).
- No fallback model configured, original error propagates.
- Fallback also fails, original error propagates.

### Files touched
- Modify: `src/config/schema.ts` (`fallbackModel`), `src/agent/loop.ts` (fallback logic), `tests/agent/loop.test.ts`

---

## A3. Max output tokens recovery

**Goal:** When the model's response is truncated due to output token limits,
inject a "continue" message and retry.

**What Claude Code does:**
- Detects `stop_reason: 'max_tokens'` in the response.
- Injects a `continue_naturally` user message.
- Retries up to 3 times, escalating `maxTokens` (8k -> 16k -> 32k -> 64k).

**What dcode should do:**

### Changes to `agent/loop.ts`
After `runTurn` returns, check `response.stop_reason`:
```ts
if (response.stop_reason === 'max_tokens' && continueRetries < 3) {
  history.push({ role: 'user', content: 'Continue.' })
  continueRetries++
  // optionally escalate maxTokens: config.maxTokens * 2 (cap at 64k)
  continue
}
```

Reset `continueRetries` when the model produces a turn with no truncation.

### Config (`config/schema.ts`)
No new fields — use existing `maxTokens` as the starting point, escalate up to
64k (hard cap).

### Tests
- Response truncated -> "Continue." injected -> next turn gets the rest.
- 3 consecutive truncations -> stop retrying.
- Non-truncated response resets the counter.

### Files touched
- Modify: `src/agent/loop.ts` (truncation detection + retry), `tests/agent/loop.test.ts`

---

## A4. Tool definition enrichment

**Goal:** Add metadata fields to `ToolDefinition` that enable smarter
scheduling, UI, and future permission systems — without adding complexity to
the existing tools.

**What Claude Code does:**
- `isReadOnly(input)`, `isDestructive(input)`, `isConcurrencySafe(input)`.
- `interruptBehavior(): 'cancel' | 'block'`.
- `maxResultSizeChars: number` per tool.
- `aliases?: string[]` for backward compatibility.
- `isSearchOrReadCommand()` for UI collapsing.

**What dcode should do:**

### Changes to `agent/types.ts`
```ts
export interface ToolDefinition<P = unknown> {
  name: string
  description: string
  parameters: z.ZodType<P>
  execute(args: P, ctx: ToolContext): Promise<string>
  parallel?: boolean  // existing
  // New metadata (all optional, all informational):
  readOnly?: boolean       // explicit read-only flag (for UI display, future scheduling)
  destructive?: boolean    // marks tools that can lose data (for future confirmation)
  interruptBehavior?: 'cancel' | 'block'  // what Ctrl-C does during this tool
  aliases?: string[]       // backward-compatible name aliases
  maxResultBytes?: number  // per-tool output cap (overrides global maxToolOutputBytes)
}
```

These fields are **not wired into any logic yet** — they are metadata for
documentation, UI display, and future phases. The `parallel` flag already
encodes read-only vs mutating for scheduling.

### Changes to `tools/registry.ts`
- `get()` should also check aliases: `get(name) { return this.tools.get(name) ?? this.aliasMap.get(name) }`
- `toResponsesTools()` should omit aliased names (only register canonical names).

### Changes to `ui/tools.ts`
- `/tools` display can show `(read-only)` / `(destructive)` annotations.

### Tests
- `get('old_name')` resolves via alias.
- Aliased tools don't appear twice in `toResponsesTools()`.
- Metadata fields are accessible on retrieved tools.

### Files touched
- Modify: `src/agent/types.ts` (new fields), `src/tools/registry.ts` (alias support), `src/ui/tools.ts` (display), `tests/tools/registry.test.ts`

---

## A5. History persistence + `/resume`

**Goal:** Save conversation transcripts to disk and resume previous sessions.

**What Claude Code does:**
- JSONL-based transcript recording (`src/history.ts`).
- Lockfile-based concurrent writes.
- `/resume` shows recent sessions and lets the user pick one.
- Paste content stored separately (hash-referenced for large pastes).
- Up-arrow history scoped to current project.

**What dcode should do:**

### Schema (`config/schema.ts`)
```ts
history: z.object({
  dir: z.string().optional(),  // defaults to ~/.local/share/dcode/history/
  maxSessions: z.number().int().positive().default(50),
}).optional(),
```

### Module: `agent/persist.ts` (new)
- `saveSession(history: ResponseInput, meta: { model: string, root: string, startedAt: number }): string`
  - Writes to `~/.local/share/dcode/history/{timestamp}-{random}.json`
  - Returns the session file path.
- `listSessions(): SessionMeta[]`
  - Reads the history directory, returns metadata (timestamp, model, root,
    message count, estimated tokens).
- `loadSession(path: string): ResponseInput`
  - Reads and parses the JSON file.

### Session metadata format
```ts
interface SessionMeta {
  path: string
  startedAt: number
  model: string
  root: string
  messageCount: number
  estimatedTokens: number
}
```

### REPL changes (`cli/repl.ts`)
- On session start (first user input), record `startedAt`.
- On `/exit` or process exit, call `saveSession()` if history has more than
  just the system message.

### New command: `/resume`
- `listSessions()` -> show last 10 sessions as a numbered list.
- User picks a number -> `loadSession(path)` -> replace `history` with loaded
  data, update `config.model` from the session metadata.
- Alternatively: `dcode --resume <path>` for one-shot from a saved session.

### Tests (`tests/agent/persist.test.ts`)
- Save and load round-trips correctly.
- `listSessions()` returns sessions sorted by date.
- Corrupted file returns empty history (graceful degradation).
- Max sessions enforced (oldest deleted).

### Files touched
- New: `src/agent/persist.ts`, `tests/agent/persist.test.ts`
- Modify: `src/config/schema.ts` (`history`), `src/cli/repl.ts` (auto-save on exit, `/resume`), `src/cli/commands.ts` (`/resume` dispatch), `src/index.ts` (`--resume` flag)

---

## A6. Streaming tool execution

**Goal:** Start executing tool calls as soon as they arrive during streaming,
rather than waiting for the full response to finish.

**What Claude Code does:**
- `StreamingToolExecutor` starts tool execution while the model is still
  streaming, as soon as `function_call` blocks are complete.
- Can save 1-5 seconds per turn when tools are slow.

**What dcode should do:**

### Changes to `agent/client.ts`
The `ModelStream` already yields text deltas. Add a parallel channel for
tool calls:

```ts
export interface ModelStream extends AsyncIterable<string> {
  finalResponse(): Promise<OpenAIResponse>
  // New: yields tool calls as they arrive (before the stream finishes)
  toolCalls(): AsyncIterable<ResponseFunctionToolCall>
}
```

Internally, the async iterator filters `response.output_item.done` events
where `item.type === 'function_call'`.

### Changes to `agent/run.ts`
`runTurn` returns early-collected tool calls alongside the text:
```ts
interface TurnResult {
  text: string
  response: OpenAIResponse
  earlyTools: ResponseFunctionToolCall[]  // collected during streaming
}
```

### Changes to `agent/loop.ts`
Instead of waiting for `finalResponse()` to extract tool calls, start
executing them as they arrive from `stream.toolCalls()`:

```ts
const earlyTools: ResponseFunctionToolCall[] = []
const toolPromise = (async () => {
  for await (const call of stream.toolCalls()) {
    earlyTools.push(call)
    // Start executing immediately (don't await)
  }
})()

// ... stream text, await toolPromise ...
// Then run the collected calls
```

This is a moderate refactor of the streaming pipeline. The key insight is
that `function_call` items are complete before the stream ends — the model
emits the call, then continues (or finishes). We can start execution as soon
as the call is fully received.

### Risk
- The OpenAI SDK's event stream may not guarantee ordering of
  `output_item.done` events relative to `response.completed`. Need to verify
  that `function_call` items are fully formed before the stream ends.
- If the model streams text after a tool call (unusual but possible), the
  tool execution would race with text rendering.

### Tests
- Tool calls start executing before the stream finishes.
- Text rendering is not affected.
- Aborted stream still yields partial tool calls.

### Files touched
- Modify: `src/agent/client.ts` (tool call channel), `src/agent/run.ts` (early tools), `src/agent/loop.ts` (start tools early)

---

## A7. Reactive compaction (multi-retry)

**Goal:** When a context overflow occurs, compact and retry up to 3 times
(instead of just once).

**What Claude Code does:**
- `reactiveCompact` retries on 413 errors with progressive compaction.
- `contextCollapse` stages multiple compaction levels.

**What dcode should do:**

### Changes to `agent/loop.ts`
Replace the single-retry overflow handler:
```ts
// Current: try once
if (isContextOverflowError(err) && await opts.context.onOverflow(...)) {
  ({ text: finalText, response } = await runOnce())
} else { throw err }

// New: retry up to 3 times
if (isContextOverflowError(err) && opts.context) {
  for (let retry = 0; retry < 3; retry++) {
    if (!(await opts.context.onOverflow(client, config, history))) break
    try {
      ({ text: finalText, response } = await runOnce())
      break  // success
    } catch (retryErr) {
      if (!isContextOverflowError(retryErr) || retry === 2) throw retryErr
    }
  }
} else { throw err }
```

### Tests
- First compaction resolves overflow.
- First compaction fails, second succeeds.
- All 3 retries fail, error propagates.

### Files touched
- Modify: `src/agent/loop.ts` (multi-retry), `tests/agent/context/manager.test.ts`

---

## A8. Skills system (model-invocable prompts)

**Goal:** Let users create reusable prompt templates that the model can invoke
via a `/skill` command or a `skill` tool.

**What Claude Code does:**
- `src/skills/` directory with bundled skills (markdown + frontmatter).
- `loadSkillsDir()` discovers skills from project/global directories.
- Skills are injected into the system prompt as available tools.
- The model uses a `skill` tool to invoke them by name.
- Skills can be bundled, from plugins, or from the filesystem.

**What dcode should do (simplified):**

### Directory structure
```
~/.config/dcode/skills/         # global skills
.dcode/skills/                  # project skills (optional)
```

### Skill format (markdown + frontmatter)
```markdown
---
name: refactor-function
description: Refactor a function to extract responsibilities
tools: [read_file, edit_file, grep, find_symbol]
---
# Refactor Function

1. Read the target function with `read_file`
2. Identify distinct responsibilities
3. Extract each into a named helper
4. Update callers with `edit_file`
5. Verify with `grep` for remaining references
```

### Module: `agent/skills.ts` (new)
- `loadSkills(dirs: string[]): Skill[]` — read + parse frontmatter.
- `Skill = { name: string, description: string, prompt: string, tools?: string[] }`

### Tool: `skill` (new, in `tools/local/skill.ts`)
```ts
defineTool({
  name: 'skill',
  description: 'Invoke a named skill (reusable prompt template)',
  parameters: z.object({
    name: z.string(),
    input: z.string().optional(),  // user-specific context
  }),
  execute(args, ctx) {
    const skill = getSkill(args.name)
    return `${skill.prompt}\n\n${args.input ?? ''}`
  },
})
```

### System prompt injection
`buildSystemPrompt` includes a section listing available skills:
```
## Skills
The following skills are available. Use the `skill` tool to invoke them:
- refactor-function: Refactor a function to extract responsibilities
- write-test: Generate comprehensive tests for a module
```

### Tests
- Load skills from directory.
- Invoke skill returns prompt content.
- Unknown skill returns error.
- Skill with tools restriction is noted.

### Files touched
- New: `src/agent/skills.ts`, `src/tools/local/skill.ts`, `tests/agent/skills.test.ts`
- Modify: `src/agent/system.ts` (inject skills list), `src/tools/index.ts` (register skill tool)

---

## A9. Hooks system (pre/post tool-use)

**Goal:** Let users run custom logic before or after tool execution (e.g.,
lint after file write, auto-format, logging).

**What Claude Code does:**
- `src/hooks/` with `HookManager` that runs pre/post tool-use hooks.
- Hooks are config-driven (`hooks` in settings).
- `preparePermissionMatcher` compiles patterns once per tool use.
- Hooks can block tool execution (pre-hook returns deny).

**What dcode should do (simplified):**

### Schema (`config/schema.ts`)
```ts
hooks: z.object({
  preTool: z.array(z.object({
    tool: z.string(),        // tool name or '*' wildcard
    command: z.string(),     // shell command to run
  })).default([]),
  postTool: z.array(z.object({
    tool: z.string(),
    command: z.string(),
  })).default([]),
}).default({ preTool: [], postTool: [] }),
```

### Module: `agent/hooks.ts` (new)
```ts
async function runHooks(
  hooks: Array<{ tool: string; command: string }>,
  toolName: string,
  ctx: ToolContext,
): Promise<void> {
  for (const hook of hooks) {
    if (hook.tool === '*' || hook.tool === toolName) {
      await execa('sh', ['-c', hook.command], { cwd: ctx.root, timeout: 10000 })
    }
  }
}
```

### Wire into `agent/run.ts`
Before `tool.execute()` in `runTool`:
```ts
await runHooks(config.hooks.preTool, tool.name, ctx)
```
After `tool.execute()`:
```ts
await runHooks(config.hooks.postTool, tool.name, ctx)
```

### Config example
```json
{
  "hooks": {
    "postTool": [
      { "tool": "write_file", "command": "prettier --write $FILE" },
      { "tool": "edit_file", "command": "eslint --fix $FILE" }
    ]
  }
}
```

### Tests
- Pre-hook runs before tool execution.
- Post-hook runs after tool execution.
- Wildcard hook runs for all tools.
- Hook failure is logged but doesn't block tool execution (non-blocking by default).

### Files touched
- New: `src/agent/hooks.ts`, `tests/agent/hooks.test.ts`
- Modify: `src/config/schema.ts` (`hooks`), `src/agent/run.ts` (hook execution)

---

## A10. Plugin system

**Goal:** Let users extend dcode with custom tools, skills, and hooks from
npm packages or local directories.

**What Claude Code does:**
- `src/plugins/` with plugin loader, lifecycle management.
- Plugins can provide tools, skills, hooks, slash commands.
- `src/services/plugins/` for plugin discovery and loading.

**What dcode should do (minimal viable plugin system):**

### Plugin format
A plugin is a directory (or npm package) exporting:
```ts
import { defineTool } from 'dcode/tools/registry'

export const tools = [
  defineTool({ name: 'my_tool', ... }),
]

export const skills = [
  { name: 'my-skill', description: '...', prompt: '...' },
]

export const hooks = {
  postTool: [{ tool: 'write_file', command: 'my-linter $FILE' }],
}
```

### Plugin discovery
```
~/.config/dcode/plugins/    # global plugins
.dcode/plugins/             # project plugins (optional)
```

### Module: `agent/plugins.ts` (new)
- `loadPlugins(dirs: string[]): Plugin[]`
- Each plugin is imported dynamically (`await import(path)`).
- Tools are registered into the `ToolRegistry`.
- Skills are loaded into the skills system.
- Hooks are merged into the hooks config.

### Config (`config/schema.ts`)
```ts
plugins: z.array(z.string()).default([]),  // plugin paths or package names
```

### Tests
- Load plugin from directory.
- Plugin tools are registered.
- Plugin skills are available.
- Invalid plugin is logged and skipped.

### Files touched
- New: `src/agent/plugins.ts`, `tests/agent/plugins.test.ts`
- Modify: `src/config/schema.ts` (`plugins`), `src/tools/index.ts` (register plugin tools), `src/agent/skills.ts` (load plugin skills)

---

## Integration with existing PLAN.md phases

| Existing Phase | Status | Relation to Adoption Plan |
|----------------|--------|---------------------------|
| P12 (symbol search) | Planned | Independent — do alongside A1-A4 |
| P13 (apply_patch / multi_edit) | Planned | Independent — do alongside A1-A4 |
| P14 (file inputs) | Candidate | Independent — do alongside A1-A4 |
| A1 (cost tracking) | New | No dependencies |
| A2 (model fallback) | New | No dependencies |
| A3 (max output tokens recovery) | New | No dependencies |
| A4 (tool definition enrichment) | New | No dependencies |
| A5 (history persistence) | New | Depends on nothing; high value |
| A6 (streaming tool execution) | New | Moderate refactor; do after A1-A4 |
| A7 (reactive compaction multi-retry) | New | Small change; do anytime |
| A8 (skills system) | New | Depends on A4 (tool metadata) |
| A9 (hooks system) | New | Depends on A4 (tool metadata) |
| A10 (plugin system) | New | Depends on A8 + A9 |

## Recommended implementation order

1. **A1 (cost tracking)** — immediate user value, no risk
2. **A3 (max output tokens recovery)** — fixes a real failure mode
3. **A4 (tool definition enrichment)** — enables future phases
4. **A7 (reactive compaction multi-retry)** — small fix, real improvement
5. **A2 (model fallback)** — safety net for production use
6. **A5 (history persistence + /resume)** — biggest UX gap
7. **A6 (streaming tool execution)** — latency improvement
8. **A8 (skills system)** — extensibility
9. **A9 (hooks system)** — customization
10. **A10 (plugin system)** — ecosystem

---

## What NOT to adopt

From the analysis, these Claude Code patterns are **not worth adopting** for
dcode's philosophy:

1. **React/Ink TUI** — massive complexity for a terminal tool. dcode's
   readline + streamed markdown is sufficient.

2. **Permission system (P5)** — already cancelled. dcode grants your own shell
   access by design; there's no sandbox boundary to enforce.

3. **Voice input** — niche feature, not core to a coding agent.

4. **Vim mode** — nice-to-have but huge scope for a text input box.

5. **Image paste** — useful but deferred to P14 (file inputs).

6. **Coordinator/multi-agent** — explicitly deferred in PLAN.md §3.

7. **LSP integration** — already planned as P12 (ripgrep-lite approach).

8. **Notebook editing** — niche; not a core workflow.

9. **Web browser** — out of scope for a terminal tool.

10. **Session memory / auto-extraction** — interesting but premature before
    basic persistence (A5) is solid.
