import type { Client, ResponseInput } from '../client.ts'
import type { Config } from '../../config/schema.ts'
import type { Logger } from '../../util/log.ts'
import type { TaskStore } from '../tasks.ts'
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
// compacting and letting the loop retry the request once.
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

  private async compact(
    client: Client,
    config: Config,
    history: ResponseInput,
  ): Promise<void> {
    const next = await compactHistory(
      client,
      config,
      history,
      this.logger,
      this.tasks?.list(),
    )
    // Replace in place via splice (not `length = 0` + `push`) so a no-op
    // compaction that returns `history` itself can't alias and wipe it.
    history.splice(0, history.length, ...next)
  }

  // Called before each model request. Returns what (if anything) it did so the
  // loop can log it. Compaction is proactive: it triggers once the estimate
  // crosses `compactAt` of the usable budget (not only at the hard limit), so a
  // long session stays comfortably under the window instead of hitting a
  // context-length error and retrying.
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
    if (this.failures >= CIRCUIT_BREAKER) return 'none'
    if (this.cfg.prune && pruneHistory(history) > 0) {
      this.logger.debug('context: pruned old tool outputs')
      if (this.predict(history) < soft) return 'pruned'
    }
    await this.compact(client, config, history)
    this.failures++
    return 'compacted'
  }

  // Called when a request failed because the context window was exceeded.
  // Compacts (if the breaker allows) and returns true so the loop retries the
  // request once; returns false when recovery is exhausted.
  async onOverflow(
    client: Client,
    config: Config,
    history: ResponseInput,
  ): Promise<boolean> {
    if (this.failures >= CIRCUIT_BREAKER) return false
    await this.compact(client, config, history)
    this.failures++
    return true
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
