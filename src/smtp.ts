/**
 * @module smtp
 * @description SMTP server — TCP socket server with per-connection session state machine.
 */

import * as tls from "node:tls";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as NodeSocketServer from "@effect/platform-bun/BunSocketServer";
import { Effect, FileSystem, Match, pipe, Queue, Ref, Stream } from "effect";
import type * as Socket from "effect/unstable/socket/Socket";
import { AccountStore } from "./account.ts";
import { AppConfig } from "./config.ts";
import { SendError, SessionDone } from "./error.ts";
import type { Account, Email, Envelope, Password, TlsConfig } from "./schema.ts";
import { SendProvider } from "./send.ts";
import * as SmtpCmd from "./smtp.command.ts";

type SmtpPhase = "greeting" | "ehlo" | "auth" | "mail" | "rcpt" | "data" | "quit";

type SmtpState = {
  readonly phase: SmtpPhase;
  readonly account: Account | undefined;
  readonly envelope: Envelope | undefined;
  readonly dataLines: ReadonlyArray<string>;
  readonly dataBytes: number;
};

const initialState: SmtpState = {
  phase: "greeting",
  account: undefined,
  envelope: undefined,
  dataLines: [],
  dataBytes: 0,
};

const processLine = (
  line: string,
  ref: Ref.Ref<SmtpState>,
  write: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  maxDataBytes: number,
) =>
  Effect.gen(function* () {
    const state = yield* Ref.get(ref);
    const cmd = SmtpCmd.parseLine(line, state.phase === "data");

    yield* Match.value(cmd).pipe(
      Match.tag("Ehlo", (cmd) =>
        state.phase !== "ehlo"
          ? write(SmtpCmd.error(503, "Bad sequence of commands"))
          : Effect.gen(function* () {
              yield* write(SmtpCmd.ehloResponse(cmd.host));
              yield* Ref.update(ref, (s) => ({ ...s, phase: "auth" as const }));
            }),
      ),
      Match.tag("AuthPlain", (cmd) =>
        state.phase !== "auth"
          ? write(SmtpCmd.error(503, "Bad sequence of commands"))
          : Effect.gen(function* () {
              const decoded = atob(cmd.encoded);
              const parts = decoded.split("\0");
              const email = (parts[1] ?? "") as Email;
              const password = (parts[2] ?? "") as Password;
              const store = yield* AccountStore;
              yield* pipe(
                store.authenticate(email, password),
                Effect.flatMap((account) =>
                  Effect.all([
                    write(SmtpCmd.authOk()),
                    Ref.update(ref, (s) => ({ ...s, phase: "mail" as const, account })),
                  ]),
                ),
                Effect.tapErrorTag("ProtocolError", (e) =>
                  Effect.logWarning("auth failed", { cause: e }),
                ),
                Effect.catchTag("ProtocolError", () => write(SmtpCmd.authFail())),
              );
            }),
      ),
      Match.tag("MailFrom", (cmd) =>
        state.phase !== "mail"
          ? write(SmtpCmd.error(503, "Bad sequence of commands"))
          : Effect.gen(function* () {
              yield* Ref.update(ref, (s) => ({
                ...s,
                phase: "rcpt" as const,
                envelope: { from: cmd.address, to: [] as ReadonlyArray<Email> },
              }));
              yield* write(SmtpCmd.ok());
            }),
      ),
      Match.tag("RcptTo", (cmd) =>
        state.phase !== "rcpt"
          ? write(SmtpCmd.error(503, "Bad sequence of commands"))
          : Effect.gen(function* () {
              yield* Ref.update(ref, (s) => ({
                ...s,
                envelope: s.envelope
                  ? { ...s.envelope, to: [...s.envelope.to, cmd.address] }
                  : { from: "" as Email, to: [cmd.address] },
              }));
              yield* write(SmtpCmd.ok());
            }),
      ),
      Match.tag("Data", () =>
        state.phase !== "rcpt"
          ? write(SmtpCmd.error(503, "Bad sequence of commands"))
          : Effect.gen(function* () {
              yield* write(SmtpCmd.startData());
              yield* Ref.update(ref, (s) => ({ ...s, phase: "data" as const }));
            }),
      ),
      Match.tag("DataLine", (cmd) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(ref);
          const lineBytes = new TextEncoder().encode(cmd.line).byteLength + 2;
          if (current.dataBytes + lineBytes > maxDataBytes) {
            yield* write(SmtpCmd.error(552, "Message exceeds maximum size"));
            yield* Ref.update(ref, (s) => ({
              ...s,
              phase: "mail" as const,
              envelope: undefined,
              dataLines: [],
              dataBytes: 0,
            }));
          } else {
            yield* Ref.update(ref, (s) => ({
              ...s,
              dataLines: [...s.dataLines, cmd.line],
              dataBytes: s.dataBytes + lineBytes,
            }));
          }
        }),
      ),
      Match.tag("DataEnd", () =>
        Effect.gen(function* () {
          const current = yield* Ref.get(ref);
          const rawBytes = new TextEncoder().encode(current.dataLines.join("\r\n"));
          const envelope = current.envelope ?? {
            from: "" as Email,
            to: [] as ReadonlyArray<Email>,
          };
          const account = current.account;

          yield* pipe(
            account?.send
              ? Effect.gen(function* () {
                  const provider = yield* SendProvider;
                  return yield* provider.send(rawBytes, envelope);
                }).pipe(Effect.provide(SendProvider.layer(account.send)))
              : Effect.fail(new SendError({ message: "No send provider configured" })),
            Effect.andThen(write(SmtpCmd.ok("Message accepted"))),
            Effect.tapErrorTag("SendError", (e) => Effect.logWarning("send failed", { cause: e })),
            Effect.catchTag("SendError", (e) => write(SmtpCmd.tempError(e.message))),
          );

          yield* Ref.update(ref, (s) => ({
            ...s,
            phase: "mail" as const,
            envelope: undefined,
            dataLines: [],
            dataBytes: 0,
          }));
        }),
      ),
      Match.tag("Rset", () =>
        Effect.gen(function* () {
          yield* Ref.update(ref, (s) => ({
            ...s,
            phase: (s.account ? "mail" : "ehlo") as SmtpPhase,
            envelope: undefined,
            dataLines: [],
            dataBytes: 0,
          }));
          yield* write(SmtpCmd.ok());
        }),
      ),
      Match.tag("Noop", () => write(SmtpCmd.ok())),
      Match.tag("Quit", () =>
        Effect.gen(function* () {
          yield* write(SmtpCmd.bye());
          yield* Ref.update(ref, (s) => ({ ...s, phase: "quit" as const }));
        }),
      ),
      Match.tag("Unknown", () => write(SmtpCmd.error(500, "Unrecognized command"))),
      Match.exhaustive,
    );
  });

const handleSession = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const { server } = yield* AppConfig;
    const maxDataBytes = server.maxDataMb * 1024 * 1024;
    const write = yield* socket.writer;
    const ref = yield* Ref.make(initialState);

    const lineQueue = yield* Stream.callback<string, Socket.SocketError>(
      Effect.fnUntraced(function* (emit) {
        yield* socket.runString((text) => Queue.offer(emit, text));
      }),
    ).pipe(Stream.splitLines, Stream.toQueue({ capacity: "unbounded" }));

    const takeLine = Queue.take(lineQueue).pipe(
      Effect.catchTag("Done", () => Effect.fail(new SessionDone())),
    );

    yield* write(SmtpCmd.greeting(server.hostname));
    yield* Ref.update(ref, (s) => ({ ...s, phase: "ehlo" as const }));

    yield* Effect.forever(
      Effect.flatMap(takeLine, (line) => processLine(line, ref, write, maxDataBytes)),
    ).pipe(Effect.catchTag("SessionDone", () => Effect.void));
  }).pipe(Effect.scoped);

export const run = (tlsConfig?: typeof TlsConfig.Type) =>
  Effect.gen(function* () {
    const { server: config } = yield* AppConfig;
    const port = config.smtpPort;

    if (tlsConfig) {
      const fs = yield* FileSystem.FileSystem;
      const cert = yield* fs.readFileString(tlsConfig.certFile);
      const key = yield* fs.readFileString(tlsConfig.keyFile);
      const server = tls.createServer({ cert, key });

      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(port, () => resume(Effect.void));
        }),
        () =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
      );

      const connections = yield* Queue.unbounded<tls.TLSSocket>();
      server.on("secureConnection", (conn) => Queue.offerUnsafe(connections, conn));

      return yield* Effect.forever(
        Effect.gen(function* () {
          const conn = yield* Queue.take(connections);
          yield* pipe(
            BunSocket.fromDuplex(
              Effect.acquireRelease(Effect.succeed(conn), (c) =>
                Effect.sync(() => {
                  if (c.closed === false) {
                    c.destroySoon();
                  }
                }),
              ),
            ),
            Effect.flatMap(handleSession),
            Effect.scoped,
            Effect.ignoreCause,
            Effect.forkDetach,
          );
        }),
      );
    }

    const server = yield* NodeSocketServer.make({ port });
    return yield* server.run(handleSession);
  }).pipe(Effect.scoped);
