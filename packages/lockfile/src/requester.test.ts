import { describe, expect, test } from "bun:test"

import { packageOverrideRequester, workspaceOverrideRequester } from "./requester"

const lock = {
  workspaces: {
    "": { name: "root" },
    "packages/app": { name: "app", version: "1.2.0" },
  },
}

describe("packageOverrideRequester", () => {
  test("reads the name and version of a registry package", () => {
    expect(packageOverrideRequester(lock, "send@0.18.0")).toEqual({
      name: "send",
      version: "0.18.0",
    })
  })

  test("reads the version of a workspace package from its workspace", () => {
    expect(packageOverrideRequester(lock, "app@workspace:packages/app")).toEqual({
      name: "app",
      version: "1.2.0",
    })
  })

  test("leaves out the version of a package from another source", () => {
    expect(packageOverrideRequester(lock, "lib@github:owner/lib#abc123")).toEqual({
      name: "lib",
      version: undefined,
    })
    expect(packageOverrideRequester(lock, "local@file:../local")).toEqual({
      name: "local",
      version: undefined,
    })
  })
})

describe("workspaceOverrideRequester", () => {
  test("reads the name and version of a workspace", () => {
    expect(workspaceOverrideRequester(lock, "packages/app")).toEqual({
      name: "app",
      version: "1.2.0",
    })
  })

  test("leaves out the version of the root workspace", () => {
    const withRootVersion = { workspaces: { "": { name: "root", version: "1.0.0" } } }

    expect(workspaceOverrideRequester(withRootVersion, "")).toEqual({
      name: "root",
      version: undefined,
    })
  })
})
