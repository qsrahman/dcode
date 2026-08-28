import type { Session } from './commands.ts'
import type { HandleResult } from './commands.ts'
import type { RunSink } from '../agent/run.ts'

export type CommandHandler = (
  session: Session,
  args: string,
  sink: RunSink,
) => HandleResult | Promise<HandleResult>

export interface CommandDefinition {
  name: string
  description: string
  aliases?: string[]
  handler: CommandHandler
}

// Registry of REPL slash commands, mirroring the tool registry: each command is
// a self-describing definition (name + help + handler), so /help and tab
// completion derive from one source instead of a separate description map that
// must be kept in sync by hand.
export class CommandRegistry {
  private byName = new Map<string, CommandDefinition>()

  register(def: CommandDefinition): void {
    this.byName.set(def.name, def)
    for (const alias of def.aliases ?? []) {
      this.byName.set(alias, def)
    }
  }

  get(name: string): CommandDefinition | undefined {
    return this.byName.get(name)
  }

  // Canonical commands only — aliases collapse to their primary definition.
  list(): CommandDefinition[] {
    const seen = new Set<CommandDefinition>()
    const out: CommandDefinition[] = []
    for (const def of this.byName.values()) {
      if (!seen.has(def)) {
        seen.add(def)
        out.push(def)
      }
    }
    return out
  }

  // Every invocable name, including aliases — used for tab completion.
  names(): string[] {
    return [...this.byName.keys()]
  }
}
