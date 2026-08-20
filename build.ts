// x2mail build — tsc + compiled binaries
import { arch, platform } from "node:os"
import { Config, Data, Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { BunRuntime } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"

class BuildError extends Data.TaggedError("BuildError")<{
  readonly target: string
  readonly logs: ReadonlyArray<unknown>
}> {}

const allTargets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64",
] as const

const build = Effect.gen(function* () {
  const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false))
  const host = yield* Config.string("BUILD_TARGET").pipe(
    Config.withDefault(`${platform()}-${arch()}`),
  )
  const targets = ci ? allTargets : [`bun-${host}` as const]

  const fs = yield* FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  yield* spawner.exitCode(
    ChildProcess.make`tsc --noEmit false --declaration --outDir dist --rootDir src --rewriteRelativeImportExtensions`,
  )

  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "x2mail-build-" })

  yield* fs.makeDirectory("./release", { recursive: true })

  yield* Effect.forEach(
    targets,
    (target) =>
      Effect.gen(function* () {
        const suffix = target.replace("bun-", "")
        const result = yield* Effect.promise(() =>
          Bun.build({
            entrypoints: ["./src/bin.ts"],
            target,
            compile: true,
            minify: true,
            outdir: tempDir,
          }),
        )

        if (!result.success) {
          return yield* Effect.fail(new BuildError({ target, logs: result.logs }))
        }

        yield* fs.rename(result.outputs[0].path, `./release/x2mail-${suffix}`)
        yield* Effect.log(`release/x2mail-${suffix}`)
      }),
    { discard: true },
  )
})

build.pipe(Effect.scoped, Effect.provide(BunServices.layer), BunRuntime.runMain)
