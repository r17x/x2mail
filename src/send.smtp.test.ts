/**
 * @module send.smtp.test
 * Level 2 provider test — proves SmtpSend by running a mock SMTP server via node:net.
 */

import * as net from "node:net";
import { Effect, Ref } from "effect";
import { describe, expect, it } from "bun:test";
import { SendError } from "./error.ts";
import type { Email, MessageId } from "./schema.ts";
import { SendProvider } from "./send.ts";
import * as SmtpSend from "./send.smtp.ts";

const encoder = new TextEncoder();

const rawMime = encoder.encode(
  "From: alice@example.com\r\nTo: bob@example.com\r\nSubject: hi\r\n\r\nHello",
);

const envelope = { from: "alice@example.com" as Email, to: ["bob@example.com" as Email] } as const;

const startMockSmtpServer = (
  captured: Ref.Ref<ReadonlyArray<string>>,
  overrideResponder?: (line: string, socket: net.Socket) => boolean,
) =>
  Effect.callback<net.Server, never>((resume) => {
    const server = net.createServer((socket) => {
      socket.write("220 mock.smtp.test ESMTP\r\n");

      let buffer = "";
      let inData = false;

      socket.on("data", (data) => {
        buffer += data.toString();
        const segments = buffer.split("\r\n");
        buffer = segments.pop() ?? "";

        for (const line of segments) {
          Effect.runSync(Ref.update(captured, (arr) => [...arr, line]));

          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 OK queued as mock-id-123\r\n");
            }
            continue;
          }

          if (overrideResponder?.(line, socket)) continue;

          if (line.startsWith("EHLO"))
            socket.write("250-mock.smtp.test\r\n250-SIZE 10485760\r\n250 OK\r\n");
          else if (line.startsWith("AUTH")) socket.write("235 2.7.0 Authentication successful\r\n");
          else if (line.startsWith("MAIL FROM")) socket.write("250 OK\r\n");
          else if (line.startsWith("RCPT TO")) socket.write("250 OK\r\n");
          else if (line === "DATA") {
            inData = true;
            socket.write("354 Go ahead\r\n");
          } else if (line === "QUIT") socket.write("221 Bye\r\n");
        }
      });
    });

    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  });

const getPort = (server: net.Server) => (server.address() as net.AddressInfo).port;

describe("SmtpSend Provider", () => {
  it("should relay email through SMTP server with correct conversation", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<string>>([]);
      const server = yield* startMockSmtpServer(captured);
      const layer = SmtpSend.make({
        host: "127.0.0.1",
        port: getPort(server),
        username: "user@test.com",
        password: "secret",
        tls: false,
      });
      const provider = yield* Effect.provide(SendProvider, layer);
      yield* provider.send(rawMime, envelope);
      server.close();
      const result = yield* Ref.get(captured);
      expect(result.some((l) => l.startsWith("EHLO"))).toBe(true);
      expect(result.some((l) => l.startsWith("AUTH PLAIN"))).toBe(true);
      expect(result.some((l) => l === "MAIL FROM:<alice@example.com>")).toBe(true);
      expect(result.some((l) => l === "RCPT TO:<bob@example.com>")).toBe(true);
      expect(result.some((l) => l === "DATA")).toBe(true);
      expect(result.some((l) => l === "QUIT")).toBe(true);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should return message ID from server response", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<string>>([]);
      const server = yield* startMockSmtpServer(captured);
      const layer = SmtpSend.make({
        host: "127.0.0.1",
        port: getPort(server),
        username: "user@test.com",
        password: "secret",
        tls: false,
      });
      const provider = yield* Effect.provide(SendProvider, layer);
      const result = yield* provider.send(rawMime, envelope);
      server.close();
      expect(result.messageId).toBe("mock-id-123" as MessageId);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should handle multiple recipients", () => {
    const multiEnvelope = {
      from: "alice@example.com" as Email,
      to: ["bob@example.com" as Email, "carol@example.com" as Email, "dave@example.com" as Email],
    } as const;

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<string>>([]);
      const server = yield* startMockSmtpServer(captured);
      const layer = SmtpSend.make({
        host: "127.0.0.1",
        port: getPort(server),
        username: "user@test.com",
        password: "secret",
        tls: false,
      });
      const provider = yield* Effect.provide(SendProvider, layer);
      yield* provider.send(rawMime, multiEnvelope);
      server.close();
      const result = yield* Ref.get(captured);
      const rcptLines = result.filter((l) => l.startsWith("RCPT TO:"));
      expect(rcptLines).toHaveLength(3);
      expect(rcptLines).toContain("RCPT TO:<bob@example.com>");
      expect(rcptLines).toContain("RCPT TO:<carol@example.com>");
      expect(rcptLines).toContain("RCPT TO:<dave@example.com>");
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should dot-stuff message lines starting with period", () => {
    const mimeWithDots = encoder.encode(
      "From: alice@example.com\r\nTo: bob@example.com\r\nSubject: dots\r\n\r\n.leading dot\r\n..double dot\r\nnormal line",
    );

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<string>>([]);
      const server = yield* startMockSmtpServer(captured);
      const layer = SmtpSend.make({
        host: "127.0.0.1",
        port: getPort(server),
        username: "user@test.com",
        password: "secret",
        tls: false,
      });
      const provider = yield* Effect.provide(SendProvider, layer);
      yield* provider.send(mimeWithDots, envelope);
      server.close();
      const result = yield* Ref.get(captured);
      expect(result.some((l) => l === "..leading dot")).toBe(true);
      expect(result.some((l) => l === "...double dot")).toBe(true);
      expect(result.some((l) => l === "normal line")).toBe(true);
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should fail with SendError on auth failure", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<string>>([]);
      const server = yield* startMockSmtpServer(captured, (line, socket) => {
        if (line.startsWith("AUTH")) {
          socket.write("535 5.7.8 Authentication credentials invalid\r\n");
          return true;
        }
        return false;
      });
      const layer = SmtpSend.make({
        host: "127.0.0.1",
        port: getPort(server),
        username: "bad@test.com",
        password: "wrong",
        tls: false,
      });
      const provider = yield* Effect.provide(SendProvider, layer);
      const result = yield* provider.send(rawMime, envelope).pipe(Effect.flip);
      server.close();
      expect(result).toBeInstanceOf(SendError);
      expect(result._tag).toBe("SendError");
      expect(result.message).toContain("235");
      expect(result.message).toContain("535");
    }).pipe(Effect.scoped, Effect.runPromise));
});
