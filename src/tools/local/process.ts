import { execa } from 'execa'
import { z } from 'zod/v4'
import { defineTool } from '../registry.ts'
import { resolvePath } from './paths.ts'
import { baseExecOptions } from './exec.ts'

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
  kill(signal: NodeJS.Signals): boolean
}

// Spawned via execa with killDescendants: true, which runs the child in its own
// process group and signals the whole group — so killing a dev server also
// kills whatever it spawned, not just the immediate shell.
//
// Deliberately not wired to any per-turn ctx.signal: a background process is
// meant to outlive the turn that launched it (that's the point of run_process
// vs run_shell), and the REPL creates a fresh AbortController per line
// anyway, so an old turn's signal would never fire again after that turn
// ends — attaching it here would be a dead reference that execa keeps alive
// for no benefit. A spawned process only stops via kill_process or when
// dcode itself exits (see the `process.on('exit', ...)` below); the tool's
// own description says so.
//
// `processManager` below is a module-level singleton, not constructed per
// session — deliberately, not an oversight. dcode is one process per
// invocation (REPL or one-shot); there is no scenario in real usage where
// two sessions share this module's state. The only place this singleton
// nature is even visible is the test suite, where vitest can share module
// state across files in the same worker — and only one test file
// (tests/tools/local.test.ts) actually spawns processes through it, with
// its own `afterEach(() => processManager.killAll())`. Making this
// per-session would mean threading a ProcessManager instance through
// ToolContext/createLocalTools for a problem that doesn't currently occur.
class ProcessManager {
  private procs = new Map<string, ManagedProcess>()
  private seq = 0

  spawn(command: string, cwd: string): ManagedProcess {
    this.evictExited()
    const handle = `proc-${++this.seq}`
    const subprocess = execa(command, [], {
      ...baseExecOptions(cwd),
      shell: true,
      killDescendants: true,
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
      kill: (sig) => subprocess.kill(sig),
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

  // Kill a process group; returns 'notfound' | 'exited' | 'signaled' |
  // 'failed'. `proc.kill()`'s own return value (whether the signal was
  // actually sent — Node's child_process.kill() returns false if it wasn't,
  // e.g. the process exited in the race between the check above and this
  // call, or the signal was rejected) used to be discarded here, always
  // reporting 'signaled' even when nothing was actually sent.
  kill(
    handle: string,
    sig: NodeJS.Signals,
  ): 'notfound' | 'exited' | 'signaled' | 'failed' {
    const proc = this.procs.get(handle)
    if (!proc) return 'notfound'
    if (proc.exited) return 'exited'
    const sent = proc.kill(sig)
    if (!sent) return proc.exited ? 'exited' : 'failed'
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

const runProcessTool = () =>
  defineTool({
    name: 'run_process',
    category: 'run',
    parallel: false,
    description:
      'Start a long-running shell command in the background and return a handle. Use read_process to get its output and kill_process to stop it. The process keeps running after this turn ends (across turns, until stopped) and /undo does not stop it; it is killed automatically only when dcode itself exits. Each call starts a new process, so do not repeat it to check on one.',
    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
      cwd: z
        .string()
        .optional()
        .describe('Working directory under the root; defaults to root'),
    }),
    async execute(args, ctx) {
      const cwd = args.cwd ? await resolvePath(ctx.root, args.cwd) : ctx.root
      const proc = processManager.spawn(args.command, cwd)
      return `started ${proc.handle} (pid ${proc.pid}): ${args.command}`
    },
  })

const readProcessTool = () =>
  defineTool({
    name: 'read_process',
    category: 'run',
    description:
      'Return recent output from a background process started with run_process: the last lines (only the latest 64 KiB is kept) and whether it is still running or has exited (with its exit code). Read-only; safe to call repeatedly.',
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
  })

const killProcessTool = () =>
  defineTool({
    name: 'kill_process',
    category: 'run',
    parallel: false,
    description:
      'Stop a background process started with run_process. Sends SIGTERM by default; use signal to choose another (e.g. SIGKILL). Safe to repeat: a process that already exited is reported, not an error.',
    parameters: z.object({
      handle: z.string().describe('Handle returned by run_process'),
      signal: z
        .enum(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL'])
        .optional()
        .describe('Signal to send (default SIGTERM)'),
    }),
    async execute(args) {
      const sig = args.signal ?? 'SIGTERM'
      const r = processManager.kill(args.handle, sig)
      if (r === 'notfound') {
        throw new Error(`unknown process handle: ${args.handle}`)
      }
      if (r === 'exited') return `${args.handle} already exited`
      if (r === 'failed') {
        throw new Error(`failed to send ${sig} to ${args.handle}`)
      }
      return `sent ${sig} to ${args.handle}`
    },
  })

export { runProcessTool, readProcessTool, killProcessTool }
