#!/usr/bin/env node
// P0 scaffold stub. Real CLI (arg parsing, one-shot, REPL) lands in P1.

const VERSION = '0.0.0'

function main(argv: string[]): void {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(`picode v${VERSION}`)
    return
  }
  console.log(`picode v${VERSION} (scaffold) — agent arrives in phase 1`)
}

main(process.argv.slice(2))
