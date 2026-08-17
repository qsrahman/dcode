import { ToolRegistry } from './registry.ts'
import { createFsTools } from './local/fs.ts'

export function createLocalTools(): ToolRegistry {
  return new ToolRegistry(createFsTools())
}
