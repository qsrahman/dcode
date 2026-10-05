import type { Client, ResponseInput } from '../client.ts'
import type { Config } from '../../config/schema.ts'
import type { Logger } from '../../util/log.ts'
import type { TaskStore } from '../types.ts'
import { estimateHistory } from './tokens.ts'
import { pruneHistory } from './prune.ts'
import { compactHistory } from './compact.ts'

// Stop trying to recover after this many consecutive over-budget compactions.
// Prevents a thrash loop where each compaction immediately refills the window
// (e.g. a single huge file the model keeps re-reading): after the limit we give
// up and let the request fail normally rather than burning calls forever.
const CIRCUIT_BREAKER = 3

export type ContextAction = 'none' | 'pruned' | 'compacted'

// Owns context-window management for a session. The loop calls `beforeTurn`
// before each model request (prune, then compact if still over budget) and
// `observe` after each response (to recalibrate the token estimate against the
// provider's real `usage`). `onOverflow` handles a context-window error by
// compacting and letting the loop retry the request (up to OVERFLOW_RETRIES in
// agent/loop.ts). Separate from CIRCUIT_BREAKER below, which counts recoveries
// that failed across the whole session rather than retries of one request.
export class ContextManager {
  // Calibration factor: real input tokens / heuristic estimate, learned from the
  // provider's `usage` so the cheap heuristic tracks the model's tokenizer.
  private ratio = 1
  private failures = 0
  private readonly cfg: Config['context']
  private readonly logger: Logger
  private readonly tasks?: TaskStore

  constructor(cfg: Config['context'], logger: Logger, tasks?: TaskStore) {
    this.cfg = cfg
    this.logger = logger
    this.tasks = tasks
  }

  // Tokens we must stay under: the model's window minus reserved headroom for
  // its output and the compaction call.
  usable(): number {
    return Math.max(0, this.cfg.window - this.cfg.reserved)
  }

  // Recalibrate against real token counts. `history` is the request that
  // produced this response, so the heuristic is measured against exactly what
  // was sent.
  observe(
    usage: { input_tokens?: number } | null | undefined,
    history: ResponseInput,
  ): void {
    const input = usage?.input_tokens
    if (input == null) return
    const heuristic = estimateHistory(history)
    this.ratio = heuristic > 0 ? input / heuristic : 1
  }

  // Estimated token count of the current request.
  predict(history: ResponseInput): number {
    return Math.round(estimateHistory(history) * this.ratio)
  }

  // Returns whether a compaction actually happened. `compactHistory` returns
  // `null` when there was nothing to summarize (the whole history already
  // fits within `keepTokens`) — callers use this to distinguish real
  // recovery progress from a no-op, e.g. so a no-op doesn't count against the
  // circuit breaker or get logged as `context: compacted`.
  private async compact(
    client: Client,
    config: Config,
    history: ResponseInput,
  ): Promise<boolean> {
    const next = await compactHistory(
      client,
      config,
      history,
      this.logger,
      this.tasks?.list(),
    )
    if (next === null) return false
    history.splice(0, history.length, ...next)
    return true
  }

  // Shared prune-then-compact recovery ladder behind both beforeTurn and
  // onOverflow: gated by the circuit breaker, try the free/local prune first,
  // fall back to a paid compaction call only if pruning didn't already do
  // enough. `stillOver` decides whether a successful prune alone is enough to
  // stop there without ever calling `compact` — the one real difference
  // between the two callers (see each's own comment for why).
  private async recover(
    client: Client,
    config: Config,
    history: ResponseInput,
    opts: { logSuffix: string; stillOver: () => boolean },
  ): Promise<ContextAction> {
    if (this.failures >= CIRCUIT_BREAKER) return 'none'
    if (this.cfg.prune && pruneHistory(history) > 0) {
      this.logger.debug('context: pruned old tool outputs%s', opts.logSuffix)
      if (!opts.stillOver()) return 'pruned'
    }
    if (!(await this.compact(client, config, history))) return 'none'
    this.failures++
    return 'compacted'
  }

  // Called before each model request. Returns what (if anything) it did so the
  // loop can log it. Compaction is proactive: it triggers once the estimate
  // crosses `compactAt` of the usable budget (not only at the hard limit), so a
  // long session stays comfortably under the window instead of hitting a
  // context-length error and retrying. A successful prune only stops the
  // ladder here if it actually brought the estimate back under the soft
  // threshold — otherwise recover() falls through to compact, since the goal
  // is staying under budget, not pruning for its own sake.
  async beforeTurn(
    client: Client,
    config: Config,
    history: ResponseInput,
  ): Promise<ContextAction> {
    if (!this.cfg.auto) return 'none'
    const soft = this.usable() * this.cfg.compactAt
    if (this.predict(history) < soft) {
      this.failures = 0
      return 'none'
    }
    return this.recover(client, config, history, {
      logSuffix: '',
      stillOver: () => this.predict(history) >= soft,
    })
  }

  // Called when a request failed because the context window was exceeded.
  // Recovers (if the breaker allows) and returns true so the loop retries
  // the request once; returns false when recovery is exhausted — including
  // when neither pruning nor compaction changed anything, since retrying
  // would just overflow identically.
  //
  // Tries pruning before compacting, same as beforeTurn does — this matters
  // most right here: beforeTurn may have *already* compacted this exact
  // turn proactively (crossing the soft threshold) only for the request to
  // still overflow the hard limit (a miscalibrated estimate, or simply not
  // enough headroom). A second compaction back-to-back is a full extra paid
  // model call; pruning is free and local, and often recovers enough space
  // on its own without needing one. Unlike beforeTurn, any successful prune
  // here is taken as sufficient (stillOver always false): the overflow
  // already happened, so freeing *any* space is real progress worth retrying
  // on, rather than a threshold to re-check. A successful prune doesn't count
  // toward the circuit breaker (it's real progress, not a failed recovery
  // attempt) — only a compaction attempt does, same as before.
  async onOverflow(
    client: Client,
    config: Config,
    history: ResponseInput,
  ): Promise<boolean> {
    const action = await this.recover(client, config, history, {
      logSuffix: ' (after overflow)',
      stillOver: () => false,
    })
    return action !== 'none'
  }

  // Manual `/compact`: summarize now regardless of the budget. Doesn't touch
  // `failures` — the circuit breaker exists to stop automatic compaction from
  // thrashing on its own, not to track user-initiated actions.
  async manual(
    client: Client,
    config: Config,
    history: ResponseInput,
  ): Promise<void> {
    await this.compact(client, config, history)
  }

  report(history: ResponseInput): { used: number; usable: number } {
    return { used: this.predict(history), usable: this.usable() }
  }
}
