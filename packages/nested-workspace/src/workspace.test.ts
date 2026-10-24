import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { restoreFiles } from "./workspace"

describe("restoreFiles", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bun-nested-workspace-restore-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("restores the other files when one cannot be written and skips unchanged files", async () => {
    const readOnly = path.join(dir, "read-only.json")
    const changed = path.join(dir, "changed.json")
    const unchanged = path.join(dir, "unchanged.json")
    await Bun.write(readOnly, "changed")
    await Bun.write(changed, "changed")
    await Bun.write(unchanged, "original")
    await chmod(readOnly, 0o444)
    await chmod(unchanged, 0o444)

    const failures = await restoreFiles(
      new Map([
        [readOnly, "original"],
        [changed, "original"],
        [unchanged, "original"],
      ]),
    )

    expect(failures.map(({ file }) => file)).toEqual([readOnly])
    expect(await Bun.file(changed).text()).toBe("original")
  })
})
