#!/usr/bin/env -S node --env-file-if-exists=.env

import { parseCli } from './cli/args.ts'
import { buildConfig } from './config/config.ts'
import { appConfigSchema } from './config/schema.ts'
import { createClient } from './agent/client.ts'
import { runOneShot } from './agent/run.ts'
import { createLogger } from './util/log.ts'
import { getVersion } from './version.ts'

const VERSION = getVersion()

function printHelp(): void {
  console.log(`dcode — AI coding agent (OpenAI Responses SDK)

Usage:
  dcode [prompt]     one-shot when a prompt is given, REPL otherwise
  dcode              start the REPL (arrives in phase 2)

Flags:
  --model <id>     Model id
  --mode <m>       interactive | auto | plan   (--auto, --plan shorthands)
  --config <path>  Path to JSON config
  --no-stream      Disable streaming
  --verbose        Verbose diagnostics (stderr)
  --no-color       Disable color
  --version        Print version
  --help           Print this help`)
}

async function main(): Promise<void> {
  // Fallback logger (defaults) covers failures during arg/config parsing,
  // which can throw before the real logger (built from config) exists.
  let logger = createLogger(appConfigSchema.parse({}))
  try {
    const args = parseCli(process.argv.slice(2))
    if (args.version) {
      console.log(`dcode v${VERSION}`)
      return
    }
    if (args.help) {
      printHelp()
      return
    }
    if (!args.prompt) {
      console.log('REPL arrives in phase 2. For a one-shot run, pass a prompt:')
      console.log('  dcode "summarize the README"')
      return
    }
    const config = buildConfig(args)
    logger = createLogger(config)
    const client = createClient(config, logger)
    await runOneShot(client, config, args.prompt, process.stdout, logger)
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
