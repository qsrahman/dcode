// Shared child_process buffer ceiling: comfortably above maxToolOutputBytes so
// normal large output is truncated (decision F) rather than killing the child.
export const CHILD_MAX_BUFFER = 10 * 1024 * 1024
