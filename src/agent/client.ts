import OpenAI from 'openai'
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsStreaming,
  ResponseInput,
  Tool as ResponsesTool,
} from 'openai/resources/responses/responses'
import type { Config } from '../config/schema.ts'

export type { ResponseInput, OpenAIResponse }

// Coarse "what the model just started doing" signals, taken from the stream's
// `response.output_item.added` events. Nothing is printed for them by the
// client; they exist so the UI can show life during a silent reasoning or
// tool-argument phase (see ui/tools.ts's onActivity).
export type StreamActivity =
  { kind: 'reasoning' } | { kind: 'tool_call'; name: string }

export interface ModelStream extends AsyncIterable<string> {
  finalResponse(): Promise<OpenAIResponse>
}

export interface Client {
  stream(
    input: ResponseInput,
    opts?: {
      tools?: ResponsesTool[]
      maxOutputTokens?: number
      instructions?: string
      signal?: AbortSignal
      onActivity?: (activity: StreamActivity) => void
      reasoningEffort?: Config['reasoningEffort']
      verbosity?: Config['verbosity']
    },
  ): ModelStream
}

// Common message wording some non-OpenAI providers/models use to signal the
// same condition. Module-level so it isn't rebuilt on every call.
const OVERFLOW_MESSAGE_RE =
  /context.length.exceeded|maximum context length|token limit|context window/i

// True when a request failed because the input exceeded the model's context
// window. Drives the loop's compact-and-retry recovery. Matches OpenAI's 413
// status and its `context_length_exceeded` error type, plain Error objects
// carrying a 413 status (non-OpenAI providers, test mocks), and the common
// message wording.
export function isContextOverflowError(err: unknown): boolean {
  const status =
    err instanceof Error && 'status' in err
      ? (err as { status?: number }).status
      : undefined
  if (status === 413) return true
  if (
    err instanceof OpenAI.APIError &&
    err.code === 'context_length_exceeded'
  ) {
    return true
  }
  return OVERFLOW_MESSAGE_RE.test(
    err instanceof Error ? err.message : String(err),
  )
}

// The SDK's ResponseStream throws these bare OpenAIErrors when the endpoint's
// events don't have the Responses API shape it accumulates against (or the
// stream carries no response at all). Matched by message like OVERFLOW_MESSAGE_RE
// above: the SDK gives them no code or subclass to match on.
const STREAM_SHAPE_RE =
  /^(missing (?:output|content) at index \d+|expected content to be |request ended without sending any events|stream ended without producing a Response)/

// A raw "missing content at index 0" reads like a dcode bug; it's nearly always
// the endpoint or model not speaking the Responses streaming protocol.
function explainStreamError(err: unknown, config: Config): unknown {
  if (!(err instanceof Error) || !STREAM_SHAPE_RE.test(err.message)) return err
  const where = config.baseURL ?? 'the default OpenAI endpoint'
  return new Error(
    `${err.message} — the streaming events from ${where} (model "${config.model}") don't match the Responses API shape the SDK expects. Try a different model or endpoint.`,
    { cause: err },
  )
}

// Thin wrapper over the OpenAI Responses SDK. Dependencies are constructed here
// so the rest of the app can depend on the Client interface and stay
// testable without network access.
export function createClient(config: Config): Client {
  // apiKey, baseURL and maxRetries are fixed into an SDK instance when it is
  // constructed, but `config` is shared and mutable: `/key` changes the key
  // mid-session. Rebuild the instance when those change, so every holder of this
  // Client (the REPL, and sub-agents via the `task` tool, which captured it at
  // startup) sees the change without being handed a new Client. Everything else
  // (model, token limits, ...) is read from `config` per request below.
  let sdk: OpenAI | undefined
  let sdkSettings = ''
  const currentSdk = (): OpenAI => {
    const settings = JSON.stringify([
      config.apiKey,
      config.baseURL,
      config.maxRetries,
    ])
    if (!sdk || settings !== sdkSettings) {
      sdk = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxRetries: config.maxRetries,
      })
      sdkSettings = settings
    }
    return sdk
  }
  currentSdk() // fail at startup, not on the first prompt, if no key is configured

  return {
    stream(input, opts) {
      const params: ResponseCreateParamsStreaming = {
        model: config.model,
        input,
        max_output_tokens: opts?.maxOutputTokens ?? config.maxTokens,
        stream: true,
      }
      if (opts?.tools) params.tools = opts.tools
      if (opts?.instructions) params.instructions = opts.instructions
      if (opts?.reasoningEffort) {
        params.reasoning = { effort: opts.reasoningEffort }
      }
      if (opts?.verbosity) params.text = { verbosity: opts.verbosity }
      // Explicit, unconditional: `store` is always exactly `config.stateful`
      // (default false, so no server-side 30-day retention on real OpenAI
      // unless the user opts in). Earlier this branched on whether the
      // configured endpoint "looked like" OpenAI, omitting the param
      // entirely for anything else on the guess that non-OpenAI endpoints
      // might reject an unrecognized field — an assumption about endpoint
      // behavior dcode has no way to actually verify, and one this project's
      // own testing (a real Ollama /v1/responses endpoint) showed to be
      // unnecessary: it accepts an explicit `store` field fine. If some
      // stricter endpoint ever does reject it, that surfaces as a clear API
      // error the user can act on — not a silent guess either way.
      params.store = config.stateful
      // Passing signal here (rather than a separate abort() method callers
      // have to remember to invoke) lets the SDK's own EventStream wire it
      // into its internal AbortController, so cancelling the turn's
      // AbortSignal cancels the HTTP request too — no extra plumbing needed.
      const s = currentSdk().responses.stream(params, { signal: opts?.signal })
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const event of s) {
              if (event.type === 'response.output_text.delta') {
                yield event.delta
              } else if (event.type === 'response.output_item.added') {
                const { item } = event
                if (item.type === 'reasoning') {
                  opts?.onActivity?.({ kind: 'reasoning' })
                } else if (item.type === 'function_call') {
                  opts?.onActivity?.({ kind: 'tool_call', name: item.name })
                }
              }
            }
          } catch (err) {
            throw explainStreamError(err, config)
          }
        },
        finalResponse: () =>
          s.finalResponse().catch((err: unknown) => {
            throw explainStreamError(err, config)
          }),
      }
    },
  }
}
