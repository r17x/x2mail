/**
 * @module receive.imap.test
 * @description Level 2 provider test — proves ImapReceive with a mock IMAP server via node:net.
 */

import * as net from "node:net";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "bun:test";
import { FetchError } from "./error";
import { ReceiveProvider } from "./receive";
import type { Hostname, MessageId, Password } from "./schema";
import * as ImapReceive from "./receive.imap";

const startMockImapServer = (messages: Record<number, string>, options?: { loginFail?: boolean }) =>
  Effect.acquireRelease(
    Effect.callback<net.Server, FetchError>((resume) => {
      const server = net.createServer((socket) => {
        socket.write("* OK IMAP4rev1 mock server ready\r\n");

        socket.on("data", (data) => {
          const line = data.toString().trim();
          const [tag = ""] = line.split(" ");
          const cmd = line.slice(tag.length + 1);

          if (cmd.startsWith("LOGIN")) {
            if (options?.loginFail) {
              socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
            } else {
              socket.write(`${tag} OK LOGIN completed\r\n`);
            }
          } else if (cmd.startsWith("SELECT")) {
            socket.write(`* ${Object.keys(messages).length} EXISTS\r\n`);
            socket.write(`${tag} OK SELECT completed\r\n`);
          } else if (cmd.startsWith("SEARCH")) {
            const nums = Object.keys(messages).join(" ");
            if (nums.length > 0) {
              socket.write(`* SEARCH ${nums}\r\n`);
            } else {
              socket.write(`* SEARCH\r\n`);
            }
            socket.write(`${tag} OK SEARCH completed\r\n`);
          } else if (cmd.startsWith("FETCH")) {
            const [, numStr = "0"] = cmd.split(" ");
            const num = parseInt(numStr);
            const msg = messages[num] ?? "";
            socket.write(`* ${num} FETCH (BODY[] {${msg.length}}\r\n`);
            socket.write(`${msg})\r\n`);
            socket.write(`${tag} OK FETCH completed\r\n`);
          } else if (cmd.startsWith("STORE")) {
            socket.write(`${tag} OK STORE completed\r\n`);
          } else if (cmd.startsWith("EXPUNGE")) {
            socket.write(`${tag} OK EXPUNGE completed\r\n`);
          } else if (cmd.startsWith("LOGOUT")) {
            socket.write(`* BYE\r\n`);
            socket.write(`${tag} OK LOGOUT completed\r\n`);
          }
        });
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.sync(() => {
        server.close();
      }),
  );

const serverPort = (server: net.Server) => (server.address() as net.AddressInfo).port;

describe("IMAP Receive Provider", () => {
  it("should connect, login, search, and fetch messages", () => {
    const msg1 = "From: alice@test.com\r\nSubject: Hello\r\n\r\nHello World";
    const msg2 = "From: bob@test.com\r\nSubject: Hi\r\n\r\nHi there";

    return Effect.gen(function* () {
      const server = yield* startMockImapServer({ 1: msg1, 2: msg2 });
      const layer = ImapReceive.make({
        provider: "imap" as const,
        host: "127.0.0.1" as Hostname,
        port: serverPort(server),
        username: "testuser",
        password: "testpass" as Password,
        tls: false,
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(DateTime.makeUnsafe("2026-01-01"));

      expect(result).toHaveLength(2);
      const [first, second] = result;
      if (!first || !second) throw new Error("expected 2 messages");
      expect(first.id).toBe("1" as MessageId);
      expect(second.id).toBe("2" as MessageId);
      expect(new TextDecoder().decode(first.raw)).toContain("Hello World");
      expect(new TextDecoder().decode(second.raw)).toContain("Hi there");
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should return empty array when no messages match", () =>
    Effect.gen(function* () {
      const server = yield* startMockImapServer({});
      const layer = ImapReceive.make({
        provider: "imap" as const,
        host: "127.0.0.1" as Hostname,
        port: serverPort(server),
        username: "testuser",
        password: "testpass" as Password,
        tls: false,
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(DateTime.makeUnsafe("2026-01-01"));

      expect(result).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should format IMAP date correctly", () => {
    expect(ImapReceive.formatImapDate(DateTime.makeUnsafe("2026-08-04T12:00:00Z"))).toBe(
      "04-Aug-2026",
    );
    expect(ImapReceive.formatImapDate(DateTime.makeUnsafe("2026-01-15T00:00:00Z"))).toBe(
      "15-Jan-2026",
    );
    expect(ImapReceive.formatImapDate(DateTime.makeUnsafe("2026-12-25T00:00:00Z"))).toBe(
      "25-Dec-2026",
    );
    expect(ImapReceive.formatImapDate(DateTime.makeUnsafe("2026-03-01T00:00:00Z"))).toBe(
      "01-Mar-2026",
    );
  });

  it("should remove message via STORE+EXPUNGE", () =>
    Effect.gen(function* () {
      const server = yield* startMockImapServer({ 1: "test message" });
      const layer = ImapReceive.make({
        provider: "imap" as const,
        host: "127.0.0.1" as Hostname,
        port: serverPort(server),
        username: "testuser",
        password: "testpass" as Password,
        tls: false,
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      yield* provider.remove("1" as MessageId);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with FetchError on login failure", () =>
    Effect.gen(function* () {
      const server = yield* startMockImapServer({}, { loginFail: true });
      const layer = ImapReceive.make({
        provider: "imap" as const,
        host: "127.0.0.1" as Hostname,
        port: serverPort(server),
        username: "testuser",
        password: "wrongpass" as Password,
        tls: false,
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(DateTime.makeUnsafe("2026-01-01")).pipe(Effect.flip);

      expect(result).toBeInstanceOf(FetchError);
      expect(result._tag).toBe("FetchError");
      expect(result.message).toContain("IMAP command failed");
    }).pipe(Effect.scoped, Effect.runPromise));
});
