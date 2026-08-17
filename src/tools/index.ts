import type { Tool } from '../agent/types.ts'
import { createFsTools } from './local/fs.ts'

export function createLocalTools(): Tool[] {
  return createFsTools()
}
