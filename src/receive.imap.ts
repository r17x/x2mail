/**
 * @module receive.imap
 * @description IMAP receive provider — fetches emails from an IMAP server over TCP+TLS.
 * Socket lifecycle managed by Effect scope via @effect/platform-bun BunSocket.
 */

import * as tls from "node:tls";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Array as Arr, DateTime, Effect, Layer, Option, Queue, Ref, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { FetchError } from "./error.ts";
import { ReceiveProvider } from "./receive.ts";
import type { ImapReceiveConfig, InboxMessage, MessageId } from "./schema.ts";

export const formatImapDate = (date: DateTime.Utc) => {
  const parts = DateTime.toPartsUtc(date);
  return `${parts.day.toString().padStart(2, "0")}-${DateTime.formatUtc(date, { month: "short", locale: "en" })}-${parts.year}`;
};

export const make = (config: typeof ImapReceiveConfig.Type) =>
  Layer.effect(
    ReceiveProvider,
    Effect.gen(function* () {
      const mkSocket = () =>
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

      const session = <A>(
        body: (s: {
          sendCommand: (cmd: string) => Effect.Effect<string, FetchError | Socket.SocketError>;
          readUntilTagged: (tag: string) => Effect.Effect<string[], FetchError | Socket.SocketError>;
        }) => Effect.Effect<A, FetchError | Socket.SocketError>,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const tagCounter = yield* Ref.make(0);
            const socket = yield* mkSocket();
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

            const nextTag = Ref.modify(tagCounter, (n) => {
              const next = n + 1;
              return [`A${next.toString().padStart(3, "0")}`, next];
            });

            const sendCommand = (cmd: string) =>
              Effect.gen(function* () {
                const tag = yield* nextTag;
                yield* write(`${tag} ${cmd}\r\n`);
                return tag;
              });

            const takeLine = Queue.take(lineQueue).pipe(
              Effect.catchTag("Done", () =>
                Effect.fail(new FetchError({ message: "IMAP connection closed unexpectedly" })),
              ),
            );

            const readUntilTagged = (tag: string) => {
              const loop = Effect.fnUntraced(function* (
                accumulated: ReadonlyArray<string>,
              ): Effect.fn.Return<string[], FetchError | Socket.SocketError> {
                const line = yield* takeLine;
                if (line.startsWith(`${tag} `)) {
                  if (!line.includes("OK")) {
                    return yield* new FetchError({ message: `IMAP command failed: ${line}` });
                  }
                  return [...accumulated];
                }
                return yield* loop([...accumulated, line]);
              });
              return loop([]);
            };

            // Greeting
            yield* takeLine;

            const loginTag = yield* sendCommand(`LOGIN ${config.username} ${config.password}`);
            yield* readUntilTagged(loginTag);

            return yield* Effect.ensuring(
              body({ sendCommand, readUntilTagged }),
              Effect.gen(function* () {
                const logoutTag = yield* sendCommand("LOGOUT");
                yield* readUntilTagged(logoutTag).pipe(Effect.ignore);
              }).pipe(Effect.ignore),
            );
          }),
        ).pipe(
          Effect.tapErrorTag("SocketError", (e) =>
            Effect.logWarning("imap socket error", { cause: e }),
          ),
          Effect.catchTag("SocketError", (e) =>
            Effect.fail(new FetchError({ message: `IMAP socket error: ${e.message}`, cause: e })),
          ),
        );

      return ReceiveProvider.of({
        fetch: Effect.fn("ReceiveProvider.fetch.imap")(function* (since) {
          return yield* session(({ sendCommand, readUntilTagged }) =>
            Effect.gen(function* () {
              const selectTag = yield* sendCommand("SELECT INBOX");
              yield* readUntilTagged(selectTag);

              const searchTag = yield* sendCommand(`SEARCH SINCE ${formatImapDate(since)}`);
              const searchResults = yield* readUntilTagged(searchTag);
              const searchLine = Arr.findFirst(searchResults, (l) => l.startsWith("* SEARCH"));
              const messageNums = Option.isSome(searchLine)
                ? searchLine.value
                    .replace("* SEARCH", "")
                    .trim()
                    .split(" ")
                    .filter((s) => s.length > 0)
                    .map(Number)
                : [];

              return yield* Effect.forEach(messageNums, (num) =>
                Effect.gen(function* () {
                  const fetchTag = yield* sendCommand(`FETCH ${num} BODY[]`);
                  const fetchResults = yield* readUntilTagged(fetchTag);
                  const contentLines =
                    fetchResults.length > 1
                      ? fetchResults.slice(
                          1,
                          fetchResults[fetchResults.length - 1] === ")" ? -1 : undefined,
                        )
                      : [];
                  const rawContent = contentLines.join("\r\n");
                  const raw = new TextEncoder().encode(rawContent);
                  return {
                    id: `${num}` as MessageId,
                    raw,
                    receivedAt: yield* DateTime.now,
                  } satisfies InboxMessage;
                }),
              );
            }),
          );
        }),

        remove: Effect.fn("ReceiveProvider.remove.imap")(function* (id) {
          yield* session(({ sendCommand, readUntilTagged }) =>
            Effect.gen(function* () {
              const selectTag = yield* sendCommand("SELECT INBOX");
              yield* readUntilTagged(selectTag);

              const storeTag = yield* sendCommand(`STORE ${id} +FLAGS (\\Deleted)`);
              yield* readUntilTagged(storeTag);

              const expungeTag = yield* sendCommand("EXPUNGE");
              yield* readUntilTagged(expungeTag);
            }),
          );
        }),
      });
    }),
  );
