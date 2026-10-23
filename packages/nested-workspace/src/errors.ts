/** Returns the message of a thrown value, which is not necessarily an `Error`. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
