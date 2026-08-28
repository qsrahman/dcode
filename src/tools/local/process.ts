import { execa } from 'execa'
import { z } from 'zod'
import type { ToolDefinition } from '../../agent/types.ts'
import { resolvePath } from './paths.ts'
import { safeEnv } from './exec.ts'

// Bound how much output a background process can accumulate in memory; a runaway
// logger shouldn't grow without limit (runTool's byte-truncation is a blunt
// backstop, not a real cap).
const PROC_MAX_OUTPUT = 64 * 1024
// Bound how many process records a session can accumulate. A long REPL session
// that calls run_process repeatedly would otherwise grow this map forever, each
// entry holding up to PROC_MAX_OUTPUT of buffered output.
const PROC_MAX_ENTRIES = 50

interface ManagedProcess {
  handle: string
  cmd: string
  pid?: number
  output: string
  exited: boolean
  exitCode: number | null
  exitSignal: string | null
  kill(signal: string): boolean
}

// Spawned via execa with killDescendants: true, which runs the child in its own
// process group and signals the whole group — so killing a dev server also
// kills whatever it spawned, not just the immediate shell.
class ProcessManager {
  private procs = new Map<string, ManagedProcess>()
  private seq = 0

  spawn(command: string, cwd: string, signal?: AbortSignal): ManagedProcess {
    this.evictExited()
    const handle = `proc-${++this.seq}`
    const subprocess = execa(command, [], {
      shell: true,
      cwd,
      env: safeEnv(),
      extendEnv: false,
      killDescendants: true,
      cancelSignal: signal,
      reject: false,
    })
    const proc: ManagedProcess = {
      handle,
      cmd: command,
      pid: subprocess.pid,
      output: '',
      exited: false,
      exitCode: null,
      exitSignal: null,
      kill: (sig) => subprocess.kill(sig as NodeJS.Signals),
    }
    const onData = (d: Buffer) => {
      proc.output += d.toString('utf8')
      if (proc.output.length > PROC_MAX_OUTPUT) {
        proc.output = proc.output.slice(-PROC_MAX_OUTPUT)
      }
    }
    subprocess.stdout?.on('data', onData)
    subprocess.stderr?.on('data', onData)
    // reject: false means this always resolves, even on non-zero exit, a
    // signal kill, a timeout, or a failure to spawn at all (e.g. ENOENT) — so
    // there's no unhandled rejection to guard against.
    void subprocess.then((result) => {
      proc.exited = true
      proc.exitCode = result.exitCode ?? null
      proc.exitSignal = result.signal ?? null
      if (result.failed && result.exitCode === undefined && !result.signal) {
        proc.output += `\n[spawn error] ${result.shortMessage}`
      }
    })
    this.procs.set(handle, proc)
    return proc
  }

  get(handle: string): ManagedProcess | undefined {
    return this.procs.get(handle)
  }

  // Kill a process group; returns 'notfound' | 'exited' | 'signaled'.
  kill(handle: string, sig: string): 'notfound' | 'exited' | 'signaled' {
    const proc = this.procs.get(handle)
    if (!proc) return 'notfound'
    if (proc.exited) return 'exited'
    proc.kill(sig)
    return 'signaled'
  }

  killAll() {
    for (const h of [...this.procs.keys()]) this.kill(h, 'SIGTERM')
  }

  // Forget exited processes once the map grows past the cap, oldest first.
  // Running processes are never evicted, regardless of the cap.
  private evictExited() {
    if (this.procs.size < PROC_MAX_ENTRIES) return
    for (const [h, p] of this.procs) {
      if (this.procs.size < PROC_MAX_ENTRIES) break
      if (p.exited) this.procs.delete(h)
    }
  }
}

export const processManager = new ProcessManager()

// Stop spawned processes when dcode exits so background jobs don't outlive it.
process.on('exit', () => processManager.killAll())

function runProcessTool(): ToolDefinition<{ command: string; cwd?: string }> {
  return {
    name: 'run_process',
    parallel: false,
    description:
      'Start a long-running shell command in the background and return a handle. Use read_process to get its output and kill_process to stop it. The process is killed when the session is cancelled.',
    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
      cwd: z
        .string()
        .optional()
        .describe('Working directory under the root; defaults to root'),
    }),
    async execute(args, ctx) {
      const cwd = args.cwd ? await resolvePath(ctx.root, args.cwd) : ctx.root
      const proc = processManager.spawn(args.command, cwd, ctx.signal)
      return `started ${proc.handle} (pid ${proc.pid}): ${args.command}`
    },
  }
}

function readProcessTool(): ToolDefinition<{ handle: string; tail?: number }> {
  return {
    name: 'read_process',
    description:
      'Return recent output from a background process started with run_process. Shows the last lines and whether it is still running or has exited (with its exit code).',
    parameters: z.object({
      handle: z
        .string()
        .describe('Handle returned by run_process (e.g. proc-1)'),
      tail: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Number of trailing lines to return (default 50)'),
    }),
    async execute(args) {
      const proc = processManager.get(args.handle)
      if (!proc) throw new Error(`unknown process handle: ${args.handle}`)
      const tail = args.tail ?? 50
      const lines = proc.output.split('\n')
      const body = lines.slice(-tail).join('\n') || '(no output yet)'
      const status = proc.exited
        ? `exited (code ${proc.exitCode ?? proc.exitSignal ?? '?'})`
        : 'running'
      return `${args.handle} ${status} — ${proc.cmd}\n${body}`
    },
  }
}

function killProcessTool(): ToolDefinition<{
  handle: string
  signal?: string
}> {
  return {
    name: 'kill_process',
    parallel: false,
    description:
      'Stop a background process started with run_process. Sends SIGTERM by default; use signal to choose another (e.g. SIGKILL).',
    parameters: z.object({
      handle: z.string().describe('Handle returned by run_process'),
      signal: z
        .string()
        .regex(/^SIG[A-Z]+$|^[0-9]+$/)
        .optional()
        .describe('Signal to send (default SIGTERM)'),
    }),
    async execute(args) {
      const sig = args.signal ?? 'SIGTERM'
      const r = processManager.kill(args.handle, sig)
      if (r === 'notfound') {
        throw new Error(`unknown process handle: ${args.handle}`)
      }
      return r === 'exited'
        ? `${args.handle} already exited`
        : `sent ${sig} to ${args.handle}`
    },
  }
}

export { runProcessTool, readProcessTool, killProcessTool }
