/**
 * @module send.smtp
 * SMTP relay provider — sends email by connecting to an external SMTP server over TCP.
 */

import * as tls from "node:tls";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Effect, Layer, Queue, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { SendError } from "./error";
import type { SmtpRelaySendConfig } from "./schema";
import { SendProvider } from "./send";

const makeSocket = (config: { host: string; port: number; tls: boolean }) =>
  config.tls
    ? BunSocket.fromDuplex(
        Effect.acquireRelease(
          Effect.sync(() => tls.connect({ host: config.host, port: config.port })),
          (conn) =>
            Effect.sync(() => {
              if (conn.closed === false) {
                if ("destroySoon" in conn) {
                  conn.destroySoon();
                } else {
                  (conn as tls.TLSSocket).destroy();
                }
              }
            }),
        ).pipe(
          Effect.flatMap((conn) =>
            Effect.callback<tls.TLSSocket, Socket.SocketError>((resume) => {
              conn.once("secureConnect", () => resume(Effect.succeed(conn)));
              conn.on("error", (cause: Error) =>
                resume(
                  Effect.fail(
                    new Socket.SocketError({
                      reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
                    }),
                  ),
                ),
              );
            }),
          ),
        ),
      )
    : BunSocket.makeNet({ host: config.host, port: config.port });

export const make = (config: typeof SmtpRelaySendConfig.Type) =>
  Layer.succeed(
    SendProvider,
    SendProvider.of({
      send: Effect.fn("SendProvider.send.smtp")(
        function* (raw, envelope) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const socket = yield* makeSocket({
                host: config.host,
                port: config.port,
                tls: config.port === 465,
              });
              const write = yield* socket.writer;

              const lineQueue = yield* Stream.callback<string, Socket.SocketError>(
                Effect.fnUntraced(function* (emit) {
                  yield* socket.runString((text) => Queue.offer(emit, text));
                }),
              ).pipe(
                Stream.splitLines,
                Stream.filter((l) => l.length > 0),
                Stream.toQueue({ capacity: "unbounded" }),
              );

              const takeLine = Queue.take(lineQueue).pipe(
                Effect.catchTag("Done", () =>
                  Effect.fail(new SendError({ message: "SMTP connection closed unexpectedly" })),
                ),
              );

              const drainMultiLine = Effect.fnUntraced(function* (
                expected: number,
              ): Effect.fn.Return<string, SendError | Socket.SocketError> {
                const line = yield* takeLine;
                const code = parseInt(line.slice(0, 3), 10);
                if (code !== expected)
                  return yield* new SendError({
                    message: `SMTP expected ${expected}, got: ${line}`,
                  });
                if (line[3] !== "-") return line;
                return yield* drainMultiLine(expected);
              });

              yield* drainMultiLine(220);
              yield* write("EHLO localhost\r\n");
              yield* drainMultiLine(250);
              yield* write(
                `AUTH PLAIN ${btoa("\0" + config.username + "\0" + config.password)}\r\n`,
              );
              yield* drainMultiLine(235);
              yield* write(`MAIL FROM:<${envelope.from}>\r\n`);
              yield* drainMultiLine(250);

              yield* Effect.forEach(
                envelope.to,
                (to) =>
                  Effect.gen(function* () {
                    yield* write(`RCPT TO:<${to}>\r\n`);
                    yield* drainMultiLine(250);
                  }),
                { discard: true },
              );

              yield* write("DATA\r\n");
              yield* drainMultiLine(354);

              const mimeText = new TextDecoder().decode(raw);
              const lines = mimeText.split("\r\n");
              const stuffed = lines.map((line) => (line.startsWith(".") ? "." + line : line));
              yield* write(stuffed.join("\r\n") + "\r\n.\r\n");

              yield* drainMultiLine(250);
              yield* write("QUIT\r\n");
              yield* drainMultiLine(221);
            }),
          );
        },
        (E) =>
          E.pipe(
            Effect.tapErrorTag("SocketError", (e) =>
              Effect.logWarning("smtp relay socket error", { cause: e }),
            ),
            Effect.catchTag("SocketError", (e) =>
              Effect.fail(new SendError({ message: `SMTP relay error: ${e.message}`, cause: e })),
            ),
          ),
      ),
    }),
  );
