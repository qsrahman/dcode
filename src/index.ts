#!/usr/bin/env -S node

import { parseCli, formatFlags } from './cli/args.ts'
import { startRepl } from './cli/repl.ts'
import { buildConfig } from './config/config.ts'
import { configSchema } from './config/schema.ts'
import { createClient } from './agent/client.ts'
import { TaskStore } from './agent/todo-store.ts'
import { runOneShot } from './agent/loop.ts'
import { createLocalTools } from './tools/index.ts'
import { createLogger, errorMessage, isAbortError } from './util/log.ts'
import { getVersion } from './version.ts'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { ensureApiKey } from './cli/auth.ts'

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
${formatFlags()}`)
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
    // Find, check, and (for a freshly pasted key) persist the API key.
    // Interactive only when no prompt was given: a one-shot run has no TTY to
    // prompt on and keeps the hard failure.
    const authError = await ensureApiKey(config, logger, !args.prompt)
    if (authError) {
      process.stderr.write(authError)
      process.exit(1)
    }
    if (!args.prompt) {
      await startRepl(config, logger)
      return
    }
    const client = createClient(config)
    const tasks = new TaskStore()
    const tools = createLocalTools(tasks, client)
    const ac = new AbortController()
    const onSigint = () => ac.abort()
    process.on('SIGINT', onSigint)
    try {
      await runOneShot(client, config, args.prompt, {
        sink: process.stdout,
        logger,
        tools,
        signal: ac.signal,
      })
    } catch (err) {
      if (isAbortError(err, ac.signal)) return
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
