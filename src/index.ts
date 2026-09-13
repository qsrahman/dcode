#!/usr/bin/env node

import { parseCli, formatFlags } from './cli/args.ts'
import { startRepl } from './cli/repl.ts'
import { buildConfig } from './config/config.ts'
import { configSchema } from './config/schema.ts'
import { createClient } from './agent/client.ts'
import { TaskStore } from './agent/todo-store.ts'
import { runOneShot } from './agent/loop.ts'
import { createLocalTools } from './tools/index.ts'
import { connectMcpServers } from './tools/mcp/manager.ts'
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
    // Decision I: MCP servers are spawned/connected at startup and closed on
    // exit here too — a one-shot run is still a full session, just a short
    // one, so it gets the same tools a REPL session would (see cli/repl.ts's
    // createSession for the REPL-side equivalent of this same sequence).
    const mcp = await connectMcpServers(config.mcpServers, logger)
    const tools = createLocalTools(tasks, client, mcp.tools)
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
