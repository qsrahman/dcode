import OpenAI from 'openai'
import { addOutputText } from 'openai/lib/ResponsesParser'
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

// Thin wrapper over the OpenAI Responses SDK. Dependencies are constructed here
// so the rest of the app can depend on the Client interface and stay
// testable without network access.
export function createClient(config: Config): Client {
  // apiKey, baseURL and maxRetries are fixed into an SDK instance when it is
  // constructed, but `config` is shared and mutable: `/key` changes the key
  // mid-session. Rebuild the instance when those change, so every holder of this
  // Client (the REPL, and sub-agents via the `sub_agent` tool, which captured it at
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
      // Raw `responses.create({ stream: true })`, not the SDK's `responses.stream()`
      // helper. The helper accumulates every event into a running Response and
      // throws when an endpoint's events don't fit its model of the protocol
      // (`missing content at index 0`), and it parses tool arguments into
      // `parsed_arguments` while the stream finishes. dcode needs neither: the
      // server's own `response.completed` event already carries the final
      // Response, so endpoints that stream loosely but finish correctly just
      // work, and malformed tool arguments stay a tool error for runTool to feed
      // back rather than a failed stream. `signal` cancels the HTTP request.
      const request = currentSdk().responses.create(params, {
        signal: opts?.signal,
      })
      // The request starts now, like the helper's did. A failure is reported to
      // whoever iterates (below); this only keeps it from being unhandled when
      // nobody does.
      void request.catch(() => {})
      let final: OpenAIResponse | undefined
      let started = false
      async function* deltas(): AsyncGenerator<string> {
        started = true
        for await (const event of await request) {
          switch (event.type) {
            case 'response.output_text.delta':
              yield event.delta
              break
            case 'response.output_item.added':
              if (event.item.type === 'reasoning') {
                opts?.onActivity?.({ kind: 'reasoning' })
              } else if (event.item.type === 'function_call') {
                opts?.onActivity?.({ kind: 'tool_call', name: event.item.name })
              }
              break
            // All three end the stream and carry the whole Response; the
            // status and incomplete_details on it say which one it was.
            case 'response.completed':
            case 'response.incomplete':
            case 'response.failed':
              final = event.response
              // `output_text` (the answer, concatenated) is a convenience the
              // SDK adds to responses it builds itself; the server's own
              // doesn't have it, and loop.ts reads it.
              if (Array.isArray(final.output)) addOutputText(final)
              break
          }
        }
      }
      return {
        [Symbol.asyncIterator]: deltas,
        async finalResponse() {
          // Callers normally drain the deltas first; if not, do it here.
          if (!started) for await (const _ of deltas()) void _
          if (!final) {
            const where = config.baseURL ?? 'the default OpenAI endpoint'
            throw new Error(
              `the stream from ${where} (model "${config.model}") ended without a response.completed event, so there is no final response. Try a different model or endpoint.`,
            )
          }
          return final
        },
      }
    },
  }
}
