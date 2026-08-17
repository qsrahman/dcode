#!/usr/bin/env -S node --env-file-if-exists=.env

import { createRequire } from 'node:module'

import { parseCli } from './cli/args.ts'
import { buildConfig } from './config/config.ts'
import { createClient } from './agent/client.ts'
import { runOneShot } from './agent/run.ts'

const require = createRequire(import.meta.url)
const { version: VERSION } = require('../package.json') as { version: string }

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
  const client = createClient(config)
  await runOneShot(client, config, args.prompt, process.stdout)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
