#!/usr/bin/env bun
import { plugin } from "bun";
import { Effect, Layer } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as FetchHttpClient from "@effect/platform-bun/BunHttpClient";
import { Command } from "effect/unstable/cli";
import pkg from "../package.json";
import { cli } from "./main.ts";
import { Config } from "./config.ts";

plugin({
  name: "x2mail",
  setup(build) {
    build.module("x2mail", () => ({
      exports: { Config },
      loader: "object",
    }));
  },
});

cli.pipe(
  Command.run({ version: pkg.version }),
  Effect.provide(Layer.mergeAll(FetchHttpClient.layer, BunServices.layer)),
  BunRuntime.runMain,
);
