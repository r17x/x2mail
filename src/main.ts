/**
 * @module main
 * CLI entry point — parse args via Effect CLI, load config, wire layers, run SMTP + POP3 + poller.
 */

import { Console, Data, Effect, FileSystem, Layer, Logger, Option, Runtime } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { AppConfig, parseConfig } from "./config.ts";
import { AccountStore } from "./account.ts";
import { MailStore } from "./store.ts";
import * as SmtpServer from "./smtp.ts";
import * as Pop3Server from "./pop3.ts";
import * as Poller from "./poller.ts";

const configTemplate = `import { Config } from "x2mail";

export default Config.make({
  accounts: [
    {
      email: "you@example.com",
      password: "your-password",
      send: Config.Send.resend({ apiKey: "re_xxxxxxxxxxxx" }),
      receive: Config.Receive.r2({
        accountId: "cf-account-id",
        apiToken: "cf-api-token",
        bucket: "my-mail-bucket",
      }),
    },
  ],
});
`;

const init = Command.make(
  "init",
  {},
  Effect.fn("x2mail.init")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists("x2mail.run.ts");
    if (exists) {
      yield* Console.error("x2mail.run.ts already exists — not overwriting.");
      return yield* new InitError();
    }
    yield* fs.writeFileString("x2mail.run.ts", configTemplate);
    yield* Console.log(`x2mail: created x2mail.run.ts

  Open x2mail.run.ts and fill in:
    email        your email address
    password     mailbox password for SMTP/POP3 auth
    send         provider credentials (Resend, Postmark, Mailgun, SES, or SMTP)
    receive      provider credentials (R2, S3, Gmail, or IMAP)

  Then start the server:
    x2mail`);
  }),
).pipe(Command.withDescription("Create a starter x2mail.run.ts config file"));

class InitError extends Data.TaggedError("InitError")<{}> {
  override readonly [Runtime.errorExitCode] = 1;
  override readonly [Runtime.errorReported] = false;
}

const x2mail = Command.make("x2mail", {
  config: Argument.string("config").pipe(
    Argument.withDefault("x2mail.run.ts"),
    Argument.withDescription("Path to config module"),
  ),
  smtpPort: Flag.optional(Flag.integer("smtp-port").pipe(Flag.withDescription("SMTP server port"))),
  pop3Port: Flag.optional(Flag.integer("pop3-port").pipe(Flag.withDescription("POP3 server port"))),
  pollInterval: Flag.optional(
    Flag.integer("poll-interval").pipe(Flag.withDescription("Poll interval in seconds")),
  ),
  log: Flag.string("log").pipe(
    Flag.withDefault("stdout"),
    Flag.withDescription("Log output: stdout or file path"),
  ),
}).pipe(
  Command.withHandler(
    Effect.fn("x2mail.run")(
      function* ({ config: configPath, smtpPort, pop3Port, pollInterval, log }) {
        const { accounts, server } = yield* parseConfig(configPath);
        const finalServer = {
          ...server,
          smtpPort: Option.getOrElse(smtpPort, () => server.smtpPort),
          pop3Port: Option.getOrElse(pop3Port, () => server.pop3Port),
          pollInterval: Option.getOrElse(pollInterval, () => server.pollInterval),
        };

        yield* Console.log(
          `x2mail — SMTP :${finalServer.smtpPort}  POP3 :${finalServer.pop3Port}  poll ${finalServer.pollInterval}s  log ${log}`,
        );

        const appLayer = Layer.mergeAll(AccountStore.layer, MailStore.layer).pipe(
          Layer.provideMerge(
            Layer.succeed(AppConfig, AppConfig.of({ accounts, server: finalServer })),
          ),
        );

        const loggerLayer = Logger.layer(
          log === "stdout" ? [Logger.defaultLogger] : [Logger.toFile(Logger.formatSimple, log)],
        );

        yield* Effect.all([SmtpServer.run(), Pop3Server.run, Poller.start], {
          concurrency: "unbounded",
        }).pipe(Effect.provide(Layer.merge(appLayer, loggerLayer)));
      },
      (E) =>
        E.pipe(
          Effect.tapErrorTag("ConfigLoadError", (e) =>
            Effect.logDebug("config load failed", { cause: e }),
          ),
          Effect.catchTag("ConfigLoadError", (e) =>
            Console.error(
              e.message === "config not found"
                ? `x2mail: config not found\n\n  Get started:\n    x2mail init          create x2mail.run.ts with a starter template\n\n  Or specify a config:\n    x2mail <path>        path to your config module`
                : `x2mail: ${e.message}`,
            ).pipe(Effect.andThen(Effect.fail(e))),
          ),
        ),
    ),
  ),
  Command.withDescription("SMTP/POP3 ↔ HTTP email proxy"),
);

export const cli = x2mail.pipe(Command.withSubcommands([init]));
