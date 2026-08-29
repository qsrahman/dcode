// marked-terminal@7 ships no .d.ts, and @types/marked-terminal on npm is
// stuck at 6.1.1 (peer range `marked >=6 <12`, mismatched with the marked
// version dcode uses). Ambient declaration scoped to just what dcode calls,
// rather than a mismatched external types package.
declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked'

  export interface MarkedTerminalOptions {
    code?: (s: string) => string
    blockquote?: (s: string) => string
    html?: (s: string) => string
    heading?: (s: string) => string
    firstHeading?: (s: string) => string
    hr?: (s: string) => string
    listitem?: (s: string) => string
    table?: (s: string) => string
    paragraph?: (s: string) => string
    strong?: (s: string) => string
    em?: (s: string) => string
    codespan?: (s: string) => string
    del?: (s: string) => string
    link?: (s: string) => string
    href?: (s: string) => string
    text?: (s: string) => string
    unescape?: boolean
    emoji?: boolean
    width?: number
    showSectionPrefix?: boolean
    reflowText?: boolean
    tab?: number
    tableOptions?: Record<string, unknown>
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension
}
