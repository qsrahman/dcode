#!/usr/bin/env node

import { parseCli, formatFlags } from './cli/args.ts'
import { startRepl } from './cli/repl.ts'
import { buildConfig, configWarnings } from './config/config.ts'
import { configSchema } from './config/schema.ts'
import { createRuntime } from './agent/runtime.ts'
import { runOneShot } from './agent/loop.ts'
import { createLogger, errorMessage, isAbortError } from './util/log.ts'
import { getVersion } from './util/version.ts'
import { ensureApiKey } from './cli/auth.ts'

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
  let logger = createLogger({ ...configSchema.parse({}), verbose: false })
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
    for (const w of configWarnings(config)) logger.warn(w)
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
    // A one-shot run is still a full session, just a short one: same client,
    // MCP servers, and tools as the REPL, closed on the way out (decision I).
    const { client, mcp, tools } = await createRuntime(config, logger)
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
      await mcp.close()
    }
  } catch (err) {
    logger.error(errorMessage(err))
    process.exit(1)
  }
}

// `import.meta.main` is true only when this module is the process entry point,
// so `main()` runs when the binary is invoked but not when a test imports it.
// The loader computes it against the resolved entry, so a global `pnpm add -g`
// install (reached through symlinks) is handled without any realpath dance.
if (import.meta.main) {
  void main()
}
