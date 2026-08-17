/**
 * @module pop3
 * @description POP3 server — TCP socket server with per-connection session state machine.
 */

import { Array as Arr, Effect, Match, pipe, Queue, Ref, Stream } from "effect";
import type * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocketServer from "@effect/platform-bun/BunSocketServer";
import * as Pop3Cmd from "./pop3.command.ts";
import { AccountStore } from "./account.ts";
import { ServerConfig } from "./config.ts";
import { SessionDone } from "./error.ts";
import { MailStore } from "./store.ts";
import type { Account, Email } from "./schema.ts";

type Pop3Phase = "auth_user" | "auth_pass" | "transaction" | "quit";

type Pop3State = {
  readonly phase: Pop3Phase;
  readonly username: Email | undefined;
  readonly account: Account | undefined;
};

const initialState: Pop3State = {
  phase: "auth_user",
  username: undefined,
  account: undefined,
};

const processLine = (
  line: string,
  state: Pop3State,
  write: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  stateRef: Ref.Ref<Pop3State>,
) =>
  Effect.gen(function* () {
    const accountStore = yield* AccountStore;
    const mailStore = yield* MailStore;
    const cmd = Pop3Cmd.parseLine(line);
    const { phase } = state;

    yield* Match.value(cmd).pipe(
      Match.tag("Quit", () =>
        Effect.gen(function* () {
          if (phase === "transaction" && state.account) {
            yield* mailStore.commitDeletes(state.account.email);
          }
          yield* write(Pop3Cmd.okResponse("bye"));
          yield* Ref.update(stateRef, (s) => ({ ...s, phase: "quit" as const }));
        }),
      ),
      Match.tag("Unknown", () => write(Pop3Cmd.errResponse("unknown command"))),
      Match.tag("User", (cmd) =>
        phase !== "auth_user"
          ? write(Pop3Cmd.errResponse("command not valid in this state"))
          : Effect.gen(function* () {
              yield* write(Pop3Cmd.okResponse());
              yield* Ref.update(stateRef, (s) => ({
                ...s,
                phase: "auth_pass" as const,
                username: cmd.name,
              }));
            }),
      ),
      Match.tag("Pass", (cmd) =>
        phase !== "auth_pass"
          ? write(Pop3Cmd.errResponse("command not valid in this state"))
          : !state.username
            ? Effect.gen(function* () {
                yield* write(Pop3Cmd.errResponse("no username"));
                yield* Ref.update(stateRef, (s) => ({
                  ...s,
                  phase: "auth_user" as const,
                  username: undefined,
                }));
              })
            : pipe(
                accountStore.authenticate(state.username, cmd.password),
                Effect.flatMap((account) =>
                  Effect.all([
                    write(Pop3Cmd.okResponse("logged in")),
                    Ref.update(stateRef, (s) => ({
                      ...s,
                      phase: "transaction" as const,
                      account,
                    })),
                  ]),
                ),
                Effect.tapErrorTag("ProtocolError", (e) =>
                  Effect.logDebug("auth failed", { cause: e }),
                ),
                Effect.catchTag("ProtocolError", () =>
                  Effect.all([
                    write(Pop3Cmd.errResponse("authentication failed")),
                    Ref.update(stateRef, (s) => ({
                      ...s,
                      phase: "auth_user" as const,
                      username: undefined,
                    })),
                  ]),
                ),
              ),
      ),
      Match.tag("Stat", () => {
        if (phase !== "transaction" || !state.account) {
          return write(Pop3Cmd.errResponse("command not valid in this state"));
        }
        const { email } = state.account;
        return Effect.gen(function* () {
          const messages = yield* mailStore.list(email);
          const totalSize = yield* mailStore.totalSize(email);
          yield* write(Pop3Cmd.statResponse(messages.length, totalSize));
        });
      }),
      Match.tag("List", (cmd) => {
        if (phase !== "transaction" || !state.account) {
          return write(Pop3Cmd.errResponse("command not valid in this state"));
        }
        const { email } = state.account;
        return cmd.msgNum === undefined
          ? Effect.gen(function* () {
              const messages = yield* mailStore.list(email);
              yield* write(
                Pop3Cmd.listResponse(
                  Arr.map(messages, (m, i) => ({ num: i + 1, size: m.raw.byteLength })),
                ),
              );
            })
          : pipe(
              mailStore.size(email, cmd.msgNum),
              Effect.flatMap((size) => write(Pop3Cmd.okResponse(`${cmd.msgNum} ${size}`))),
              Effect.tapErrorTag("ProtocolError", (e) =>
                Effect.logDebug("list failed", { cause: e }),
              ),
              Effect.catchTag("ProtocolError", () => write(Pop3Cmd.errResponse("no such message"))),
            );
      }),
      Match.tag("Retr", (cmd) => {
        if (phase !== "transaction" || !state.account) {
          return write(Pop3Cmd.errResponse("command not valid in this state"));
        }
        const { email } = state.account;
        return pipe(
          mailStore.get(email, cmd.msgNum),
          Effect.flatMap((message) => write(Pop3Cmd.messageResponse(message.raw))),
          Effect.tapErrorTag("ProtocolError", (e) => Effect.logDebug("retr failed", { cause: e })),
          Effect.catchTag("ProtocolError", () => write(Pop3Cmd.errResponse("no such message"))),
        );
      }),
      Match.tag("Dele", (cmd) => {
        if (phase !== "transaction" || !state.account) {
          return write(Pop3Cmd.errResponse("command not valid in this state"));
        }
        const { email } = state.account;
        return pipe(
          mailStore.markDelete(email, cmd.msgNum),
          Effect.flatMap(() => write(Pop3Cmd.okResponse("deleted"))),
          Effect.tapErrorTag("ProtocolError", (e) => Effect.logDebug("dele failed", { cause: e })),
          Effect.catchTag("ProtocolError", () => write(Pop3Cmd.errResponse("no such message"))),
        );
      }),
      Match.tag("Noop", () =>
        phase !== "transaction"
          ? write(Pop3Cmd.errResponse("command not valid in this state"))
          : write(Pop3Cmd.okResponse()),
      ),
      Match.exhaustive,
    );
  });

const handleSession = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const write = yield* socket.writer;
    const stateRef = yield* Ref.make<Pop3State>(initialState);

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
      Effect.catchTag("Done", () => Effect.fail(new SessionDone())),
    );

    yield* write(Pop3Cmd.greeting());

    yield* Effect.forever(
      Effect.gen(function* () {
        const s = yield* Ref.get(stateRef);
        if (s.phase === "quit") return yield* new SessionDone();
        const line = yield* takeLine;
        yield* processLine(line, s, write, stateRef);
      }),
    ).pipe(Effect.catchTag("SessionDone", () => Effect.void));
  }).pipe(Effect.scoped);

export const run = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const server = yield* NodeSocketServer.make({ port: config.pop3Port });
  return yield* server.run(handleSession);
}).pipe(Effect.scoped);
