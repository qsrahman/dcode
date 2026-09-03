import { parseArgs } from 'node:util'

export interface ParsedArgs {
  prompt?: string
  model?: string
  config?: string
  noColor: boolean
  verbose: boolean
  version: boolean
  help: boolean
}

// One table describing every flag: its parseArgs shape and its help text.
// Previously the two lived apart — `options` here and a hand-written block in
// index.ts's printHelp — and had already drifted: none of the four short
// forms (-m, -c, -v, -h) were documented anywhere the user could see them.
interface FlagSpec {
  name: string
  type: 'string' | 'boolean'
  short?: string
  // Placeholder shown after the flag in --help, for value-taking flags.
  arg?: string
  help: string
}

const FLAGS: FlagSpec[] = [
  { name: 'model', type: 'string', short: 'm', arg: '<id>', help: 'Model id' },
  {
    name: 'config',
    type: 'string',
    short: 'c',
    arg: '<path>',
    help: 'Path to JSON config',
  },
  { name: 'verbose', type: 'boolean', help: 'Verbose diagnostics (stderr)' },
  { name: 'no-color', type: 'boolean', help: 'Disable color' },
  { name: 'version', type: 'boolean', short: 'v', help: 'Print version' },
  { name: 'help', type: 'boolean', short: 'h', help: 'Print this help' },
]

type ParseArgsOptions = NonNullable<Parameters<typeof parseArgs>[0]>['options']

const OPTIONS = Object.fromEntries(
  FLAGS.map((f) => [
    f.name,
    f.short ? { type: f.type, short: f.short } : { type: f.type },
  ]),
) as ParseArgsOptions

// Rendered flag reference for `--help`, derived from the same table the parser
// uses so a new flag can't be added without appearing here.
export function formatFlags(): string {
  const left = FLAGS.map(
    (f) =>
      `  ${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.arg ? ` ${f.arg}` : ''}`,
  )
  const width = Math.max(...left.map((l) => l.length))
  return FLAGS.map((f, i) => `${left[i]!.padEnd(width)}  ${f.help}`).join('\n')
}

// Pure CLI parser. `color` is surfaced as a negation (--no-color) because it
// defaults to on; config merge treats an explicit negation as a CLI override
// and otherwise leaves the file/default in place.
//
// Strict: an unrecognized flag is an error, not something to shrug off. With
// parseArgs' lenient mode a typo was silently destructive rather than merely
// ignored — `dcode --modle gpt-4 "do a thing"` dropped the flag *and* pulled
// its value into the positionals, running the default model against the
// prompt "gpt-4 do a thing". This matches the config file, which already
// rejects unknown keys via configSchema.strict().
export function parseCli(argv: string[]): ParsedArgs {
  let values: Record<string, unknown>
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
    }))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      // Node's own message already explains the `--` escape for positionals
      // that start with a dash; only the flag reference needs adding.
      throw new Error(
        `${(err as Error).message}\nRun \`dcode --help\` for the flag list.`,
      )
    }
    throw err
  }

  return {
    prompt: positionals.length ? positionals.join(' ') : undefined,
    model: typeof values.model === 'string' ? values.model : undefined,
    config: typeof values.config === 'string' ? values.config : undefined,
    noColor: values['no-color'] === true,
    verbose: values.verbose === true,
    version: values.version === true,
    help: values.help === true,
  }
}
