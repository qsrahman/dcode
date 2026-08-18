#!/usr/bin/env -S node --env-file-if-exists=.env

import { parseCli } from './cli/args.ts'
import { startRepl } from './cli/repl.ts'
import { buildConfig } from './config/config.ts'
import { appConfigSchema } from './config/schema.ts'
import { createClient } from './agent/client.ts'
import { runOneShot } from './agent/loop.ts'
import { createLocalTools } from './tools/index.ts'
import { createLogger, errorMessage } from './util/log.ts'
import { getVersion } from './version.ts'

const VERSION = getVersion()

function printHelp(): void {
  console.log(`dcode — AI coding agent (OpenAI Responses SDK)

Usage:
  dcode [prompt]     one-shot when a prompt is given, REPL otherwise
  dcode              start the REPL

Flags:
  --model <id>     Model id
  --mode <m>       interactive | auto | plan   (--auto, --plan shorthands)
  --config <path>  Path to JSON config
  --verbose        Verbose diagnostics (stderr)
  --no-color       Disable color
  --version        Print version
  --help           Print this help`)
}

async function main(): Promise<void> {
  // A defaults logger is created up front so the catch block can report
  // arg/config parse failures. The real, config-driven logger isn't built
  // until buildConfig succeeds, and that call can itself throw.
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
    const config = buildConfig(args)
    logger = createLogger(config)
    if (!args.prompt) {
      await startRepl(config, logger)
      return
    }
    const client = createClient(config, logger)
    const tools = createLocalTools()
    await runOneShot(client, config, args.prompt, process.stdout, logger, tools)
  } catch (err) {
    logger.error(errorMessage(err))
    process.exit(1)
  }
}

main()
