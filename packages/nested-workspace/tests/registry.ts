// Local npm registry for tests that install registry packages offline.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** Package version served by the registry, with its files relative to the package root. */
export interface RegistryPackage {
  name: string
  version: string
  dependencies?: Record<string, string>
  bin?: Record<string, string>
  files?: Record<string, string>
}

/** Running registry; `url` ends with a slash, as Bun expects. */
export interface Registry extends AsyncDisposable {
  url: string
}

/**
 * Starts a registry that serves the given versions of unscoped packages.
 *
 * Packs tarballs with the system `tar`.
 */
export async function startRegistry(packages: readonly RegistryPackage[]): Promise<Registry> {
  const dir = await mkdtemp(path.join(tmpdir(), "bun-nested-workspace-registry-"))
  const tarballs = new Map<string, Uint8Array>()
  for (const pkg of packages) {
    const { files = {}, ...manifest } = pkg
    for (const [file, content] of Object.entries({
      ...files,
      "package.json": JSON.stringify(manifest),
    })) {
      await Bun.write(path.join(dir, pkg.name, pkg.version, "package", file), content)
    }
    const tarball = path.join(dir, `${pkg.name}-${pkg.version}.tgz`)
    const tar = Bun.spawnSync([
      "tar",
      "-czf",
      tarball,
      "-C",
      path.join(dir, pkg.name, pkg.version),
      "package",
    ])
    if (tar.exitCode !== 0) {
      throw new Error(`tar failed: ${tar.stderr.toString()}`)
    }
    tarballs.set(`${pkg.name}-${pkg.version}.tgz`, await Bun.file(tarball).bytes())
  }

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      const tarball = tarballs.get(path.posix.basename(pathname))
      if (pathname.includes("/-/") && tarball) {
        return new Response(tarball)
      }
      const name = decodeURIComponent(pathname.slice(1))
      const versions = packages.filter(pkg => pkg.name === name)
      if (!versions.length) {
        return new Response("Not found", { status: 404 })
      }
      return Response.json({
        name,
        "dist-tags": { latest: versions.at(-1)!.version },
        versions: Object.fromEntries(
          versions.map(({ files: _files, ...manifest }) => {
            const file = `${name}-${manifest.version}.tgz`
            const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(tarballs.get(file)!).digest("base64")}`
            return [
              manifest.version,
              {
                ...manifest,
                dist: { tarball: new URL(`/${name}/-/${file}`, request.url).href, integrity },
              },
            ]
          }),
        ),
      })
    },
  })

  return {
    url: server.url.href,
    async [Symbol.asyncDispose]() {
      await server.stop(true)
      await rm(dir, { recursive: true, force: true })
    },
  }
}
