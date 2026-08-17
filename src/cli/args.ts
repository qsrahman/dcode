import { parseArgs } from 'node:util'

export interface ParsedArgs {
  prompt?: string
  model?: string
  mode?: string
  auto: boolean
  plan: boolean
  config?: string
  noColor: boolean
  verbose: boolean
  version: boolean
  help: boolean
}

// Pure CLI parser. `color` is surfaced as a negation (--no-color) because it
// defaults to on; config merge treats an explicit negation as a CLI override
// and otherwise leaves the file/default in place.
export function parseCli(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      model: { type: 'string', short: 'm' },
      mode: { type: 'string' },
      auto: { type: 'boolean' },
      plan: { type: 'boolean' },
      config: { type: 'string', short: 'c' },
      'no-color': { type: 'boolean' },
      verbose: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  return {
    prompt: positionals.length ? positionals.join(' ') : undefined,
    model: typeof values.model === 'string' ? values.model : undefined,
    mode: typeof values.mode === 'string' ? values.mode : undefined,
    auto: values.auto === true,
    plan: values.plan === true,
    config: typeof values.config === 'string' ? values.config : undefined,
    noColor: values['no-color'] === true,
    verbose: values.verbose === true,
    version: values.version === true,
    help: values.help === true,
  }
}
