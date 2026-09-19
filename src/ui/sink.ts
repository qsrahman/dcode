export interface RunSink {
  write(text: string): void
}

// A RunSink that accumulates everything written instead of forwarding it —
// used by scripts/live-stress.ts to capture a turn's rendered output for
// UI-spacing assertions without printing it live.
export class CapturingSink implements RunSink {
  text = ''
  write(s: string): void {
    this.text += s
  }
}
