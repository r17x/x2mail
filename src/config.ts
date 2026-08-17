/**
 * @module config
 * @description Xh2m config surface — Config entry point, ServerConfig service, and config loader.
 */

import { Context, Data, Effect, Path, Runtime, Schema } from "effect";
import { ServerConfig as ServerConfigSchema, XhConfig } from "./schema.ts";
export { Email, Password, MessageId, MsgNum, Hostname, Envelope, InboxMessage } from "./schema.ts";

export const Config = <E, R>(
  program: Effect.Effect<typeof XhConfig.Encoded, E, R>,
) => program;

export class ServerConfig extends Context.Service<
  ServerConfig,
  typeof ServerConfigSchema.Type
>()("xh2m/ServerConfig") {}

export const Send = {
  resend: (cfg: { apiKey: string }) => ({ ...cfg, provider: "resend" as const }),
  postmark: (cfg: { serverToken: string }) => ({ ...cfg, provider: "postmark" as const }),
  mailgun: (cfg: { apiKey: string; domain: string }) => ({ ...cfg, provider: "mailgun" as const }),
  ses: (cfg: { accessKeyId: string; secretAccessKey: string; region: string }) => ({ ...cfg, provider: "ses" as const }),
  smtp: (cfg: { host: string; port: number; username: string; password: string }) => ({ ...cfg, provider: "smtp" as const }),
} as const;

export const Receive = {
  r2: (cfg: { accountId: string; apiToken: string; bucket: string }) => ({ ...cfg, provider: "r2" as const }),
  s3: (cfg: { accessKeyId: string; secretAccessKey: string; region: string; bucket: string }) => ({ ...cfg, provider: "s3" as const }),
  gmail: (cfg: { clientId: string; clientSecret: string; refreshToken: string }) => ({ ...cfg, provider: "gmail" as const }),
  imap: (cfg: { host: string; port: number; username: string; password: string; tls: boolean }) => ({ ...cfg, provider: "imap" as const }),
} as const;

export const parseConfig = (configPath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolved = path.resolve(configPath);
    const mod = yield* Effect.tryPromise({
      try: () => import(resolved),
      catch: (cause) =>
        new ConfigLoadError({
          message: String(cause).includes("Cannot find module")
            ? "config not found"
            : "Failed to import config",
          cause,
        }),
    });
    const raw = Effect.isEffect(mod.default)
      ? yield* (mod.default as Effect.Effect<unknown>).pipe(
          Effect.mapError(
            (cause) => new ConfigLoadError({ message: "Config program failed", cause }),
          ),
        )
      : mod.default;
    return yield* Schema.decodeUnknownEffect(XhConfig)(raw).pipe(
      Effect.mapError((cause) => new ConfigLoadError({ message: "Invalid config", cause })),
    );
  });

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  override readonly [Runtime.errorExitCode] = 1;
  override readonly [Runtime.errorReported] = false;
}
