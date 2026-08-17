/**
 * @module main
 * CLI entry point — parse args via Effect CLI, load config, wire layers, run SMTP + POP3 + poller.
 */

import { Console, Data, Effect, FileSystem, Layer, Option, Runtime } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as FetchHttpClient from "@effect/platform-bun/BunHttpClient";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { parseConfig, ServerConfig } from "./config.ts";
import * as AccountStoreModule from "./account.ts";
import * as Store from "./store.ts";
import * as SmtpServer from "./smtp.ts";
import * as Pop3Server from "./pop3.ts";
import * as Poller from "./poller.ts";

const configTemplate = `import { Config, Send, Receive } from "xh2m";
import { Effect } from "effect";

export default Config(Effect.succeed({
  accounts: [
    {
      email: "you@example.com",
      password: "your-password",
      send: Send.resend({ apiKey: "re_xxxxxxxxxxxx" }),
      receive: Receive.r2({
        accountId: "cf-account-id",
        apiToken: "cf-api-token",
        bucket: "my-mail-bucket",
      }),
    },
  ],
}));
`;

const init = Command.make(
  "init",
  {},
  Effect.fn("xh2m.init")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists("xh2m.run.ts");
    if (exists) {
      yield* Console.error("xh2m.run.ts already exists — not overwriting.");
      return yield* new InitError();
    }
    yield* fs.writeFileString("xh2m.run.ts", configTemplate);
    yield* Console.log(`xh2m: created xh2m.run.ts

  Open xh2m.run.ts and fill in:
    email        your email address
    password     mailbox password for SMTP/POP3 auth
    send         provider credentials (Resend, Postmark, Mailgun, SES, or SMTP)
    receive      provider credentials (R2, S3, Gmail, or IMAP)

  Then start the server:
    xh2m`);
  }),
).pipe(Command.withDescription("Create a starter xh2m.run.ts config file"));

class InitError extends Data.TaggedError("InitError")<{}> {
  override readonly [Runtime.errorExitCode] = 1;
  override readonly [Runtime.errorReported] = false;
}

const xh2m = Command.make(
  "xh2m",
  {
    config: Argument.string("config").pipe(
      Argument.withDefault("xh2m.run.ts"),
      Argument.withDescription("Path to config module"),
    ),
    smtpPort: Flag.optional(
      Flag.integer("smtp-port").pipe(Flag.withDescription("SMTP server port")),
    ),
    pop3Port: Flag.optional(
      Flag.integer("pop3-port").pipe(Flag.withDescription("POP3 server port")),
    ),
    pollInterval: Flag.optional(
      Flag.integer("poll-interval").pipe(Flag.withDescription("Poll interval in seconds")),
    ),
  },
  Effect.fn("xh2m.run")(function* ({ config: configPath, smtpPort, pop3Port, pollInterval }) {
    const { accounts, server } = yield* parseConfig(configPath);
    const finalServer = {
      ...server,
      smtpPort: Option.getOrElse(smtpPort, () => server.smtpPort),
      pop3Port: Option.getOrElse(pop3Port, () => server.pop3Port),
      pollInterval: Option.getOrElse(pollInterval, () => server.pollInterval),
    };

    yield* Console.log(`xh2m — SMTP :${finalServer.smtpPort}  POP3 :${finalServer.pop3Port}  poll ${finalServer.pollInterval}s`);

    const appLayer = Layer.mergeAll(AccountStoreModule.make(accounts), Store.layer).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, ServerConfig.of(finalServer))),
    );

    yield* Effect.all([SmtpServer.run(), Pop3Server.run(), Poller.start(accounts)], {
      concurrency: "unbounded",
    }).pipe(Effect.provide(appLayer));
  }),
).pipe(Command.withDescription("SMTP/POP3 ↔ HTTP email proxy"));

xh2m.pipe(
  Command.withSubcommands([init]),
  Command.run({ version: "0.0.0" }),
  Effect.tapErrorTag("ConfigLoadError", (e) => Effect.logWarning("config load failed", { cause: e })),
  Effect.catchTag("ConfigLoadError", (e) =>
    Console.error(
      e.message === "config not found"
        ? `xh2m: config not found\n\n  Get started:\n    xh2m init          create xh2m.run.ts with a starter template\n\n  Or specify a config:\n    xh2m <path>        path to your config module`
        : `xh2m: ${e.message}`,
    ).pipe(Effect.andThen(Effect.fail(e))),
  ),
  Effect.provide(Layer.mergeAll(FetchHttpClient.layer, BunServices.layer)),
  BunRuntime.runMain,
);
