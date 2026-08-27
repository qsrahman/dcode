#!/usr/bin/env -S node --env-file-if-exists=.env

import { parseCli } from './cli/args.ts'
import { startRepl } from './cli/repl.ts'
import { buildConfig } from './config/config.ts'
import { configSchema } from './config/schema.ts'
import { createClient } from './agent/client.ts'
import { TaskStore } from './agent/tasks.ts'
import { runOneShot } from './agent/loop.ts'
import { createLocalTools } from './tools/index.ts'
import type { StreamRef } from './agent/run.ts'
import { createLogger, errorMessage } from './util/log.ts'
import { getVersion } from './version.ts'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { validateApiKey } from './cli/auth.ts'

// True when this module is the process entry point. Resolving symlinks matters:
// a global `pnpm add -g` install is reached through symlinks, so the raw
// argv[1] path and import.meta.url differ in their symlink components and a
// naive string compare would wrongly conclude we're imported (not run), leaving
// main() uncalled and the binary silently exiting 0.
function isMainModule(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return (
      realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

function printHelp(): void {
  console.log(`dcode — AI coding agent

Usage:
  dcode [prompt]     one-shot when a prompt is given, REPL otherwise
  dcode              start the REPL

Flags:
  --model <id>     Model id
  --config <path>  Path to JSON config
  --verbose        Verbose diagnostics (stderr)
  --no-color       Disable color
  --version        Print version
  --help           Print this help`)
}

export async function main(): Promise<void> {
  // A defaults logger is created up front so the catch block can report
  // arg/config parse failures. The real, config-driven logger isn't built
  // until buildConfig succeeds, and that call can itself throw.
  let logger = createLogger(configSchema.parse({}))
  try {
    const args = parseCli(process.argv.slice(2))
    if (args.version) {
      console.log(`dcode v${getVersion()}`)
      return
    }
    if (args.help) {
      printHelp()
      return
    }
    const config = buildConfig(args)
    logger = createLogger(config)
    if (!config.apiKey) {
      process.stderr.write(
        'OPENAI_API_KEY is not set — dcode needs an OpenAI-compatible API key to run.\n\n' +
          'Provide it (highest precedence first): environment, global config, or local:\n' +
          "  shell profile:  echo 'export OPENAI_API_KEY=sk-...' >> ~/.zshrc\n" +
          '  global config:  run  /key set openai sk-...  in the REPL (persists anywhere)\n' +
          '  local dcode.json: set "apiKey", or put OPENAI_API_KEY=sk-... in a .env here\n' +
          'Then restart dcode.\n',
      )
      process.exit(1)
    }
    if (!(await validateApiKey(config))) {
      const base = config.baseURL ?? 'https://api.openai.com/v1'
      process.stderr.write(
        `OPENAI_API_KEY is invalid (authentication failed) — dcode could not ` +
          `authenticate with the configured endpoint (${base}).\n\n` +
          'Check the value in your shell profile (.zshrc/.bashrc), .env file, or\n' +
          'dcode.json config, then restart dcode.\n',
      )
      process.exit(1)
    }
    if (!args.prompt) {
      await startRepl(config, logger)
      return
    }
    const client = createClient(config)
    const tasks = new TaskStore()
    const tools = createLocalTools(tasks)
    const ac = new AbortController()
    const streamRef: StreamRef = { current: null }
    const onSigint = () => {
      ac.abort()
      streamRef.current?.abort()
    }
    process.on('SIGINT', onSigint)
    try {
      await runOneShot(client, config, args.prompt, {
        sink: process.stdout,
        logger,
        tools,
        signal: ac.signal,
        streamRef,
      })
    } catch (err) {
      if (ac.signal.aborted) return
      throw err
    } finally {
      process.off('SIGINT', onSigint)
    }
  } catch (err) {
    logger.error(errorMessage(err))
    process.exit(1)
  }
}

if (isMainModule()) {
  void main()
}
