import { styleText } from 'node:util'

export type Paint = (s: string) => string

const STYLES = ['dim', 'red', 'green', 'yellow', 'cyan'] as const
type Style = (typeof STYLES)[number]

// Build colorizers from an explicit flag rather than letting `styleText`
// auto-detect, and never touch any global enable/disable switch (which would
// leak across tests). Auto-detection is the wrong input twice over: Node
// resolves colour support once at startup, before `--no-color` has even been
// parsed out of argv, and the answer it reaches describes stdout rather than
// whichever sink the caller is actually writing to. `config.color` already
// folds both the flag and the detected support together, so it is the single
// thing worth consulting. When colour is off every paint is identity, so
// callers never branch on it themselves.
export function paintFor(color: boolean): Record<Style, Paint> {
  const paints = {} as Record<Style, Paint>
  for (const style of STYLES) {
    paints[style] = color ? (s) => styleText(style, s) : (s) => s
  }
  return paints
}
