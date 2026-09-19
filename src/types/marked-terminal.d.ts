// marked-terminal@7 ships no .d.ts, and @types/marked-terminal on npm is
// stuck at 6.1.1 (peer range `marked >=6 <12`, mismatched with the marked
// version dcode uses). Ambient declaration scoped to just what dcode calls
// (a no-argument markedTerminal()); add options here only as they're used.
declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked'

  export function markedTerminal(): MarkedExtension
}
