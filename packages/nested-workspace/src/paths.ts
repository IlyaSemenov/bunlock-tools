/** Returns whether a POSIX path relative to the host root lies inside the nested directory. */
export function isNestedPath(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`)
}
