#!/usr/bin/env -S node

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
import { setGlobalKey } from './cli/keys.ts'
import * as readline from 'node:readline'

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

// First-run key bootstrap for interactive (REPL) startup: if no API key is
// available from env or config, prompt once. The key is only persisted after it
// validates (see main), so a bad paste isn't stored. Visible input (no hidden
// echo); only runs on a TTY so piped/one-shot use doesn't block. Returns the
// entered key, or '' if skipped/empty.
async function promptForApiKey(): Promise<string> {
  if (!process.stdin.isTTY) return ''
  process.stderr.write(
    'No API key found. Paste your OpenAI-compatible key (saved to the global config):\n> ',
  )
  const rl = readline.createInterface({ input: process.stdin })
  const line = await new Promise<string>((resolve) => {
    rl.once('line', (l) => resolve(l))
    rl.once('close', () => resolve(''))
  })
  rl.close()
  return line.trim()
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
    // First-run key bootstrap (REPL/interactive only): if no key is available
    // from env or config, prompt once. The key is only persisted after it
    // validates, so a typo can't get stuck in the global config. One-shot use
    // (a prompt was given) keeps the hard failure — there's no TTY to prompt on.
    let promptedKey = ''
    if (!args.prompt && !config.apiKey) {
      promptedKey = await promptForApiKey()
      if (promptedKey) config.apiKey = promptedKey
    }
    if (!config.apiKey) {
      process.stderr.write(
        'OPENAI_API_KEY is not set — dcode needs an OpenAI-compatible API key to run.\n\n' +
          'Provide it one of these ways:\n' +
          "  shell profile:  echo 'export OPENAI_API_KEY=sk-...' >> ~/.zshrc\n" +
          '  interactive:    paste it when dcode prompts on startup (saved to global config)\n' +
          '  /key command:   run  /key set openai sk-...  in the REPL\n' +
          'Then restart dcode if you used the shell profile.\n',
      )
      process.exit(1)
    }
    if (!(await validateApiKey(config))) {
      const base = config.baseURL ?? 'https://api.openai.com/'
      process.stderr.write(
        `OPENAI_API_KEY is invalid (authentication failed) — dcode could not ` +
          `authenticate with the configured endpoint (${base}).\n\n` +
          'Check the value in your shell profile (.zshrc/.bashrc) or dcode.json config, then\n' +
          'restart dcode.\n',
      )
      process.exit(1)
    }
    // Persist a freshly prompted key now that it has validated.
    if (promptedKey) setGlobalKey('apiKey', promptedKey)
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
