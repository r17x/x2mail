/**
 * @module send.mailgun.test
 * Level 2 provider test — proves MailgunSend by swapping HttpClient via mock fetch.
 */

import { Effect, Layer, Ref } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, it } from "bun:test";
import { SendError } from "./error";
import type { Email } from "./schema";
import { SendProvider } from "./send";
import * as MailgunSend from "./send.mailgun";

const encoder = new TextEncoder();

const rawMime = encoder.encode(
  "From: alice@example.com\r\nTo: bob@example.com\r\nSubject: hi\r\n\r\nHello",
);

const envelope = {
  from: "alice@example.com" as Email,
  to: ["bob@example.com" as Email, "carol@example.com" as Email],
} as const;

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  formEntries: Record<string, string>;
};

const makeMockFetch = (
  captured: Ref.Ref<ReadonlyArray<CapturedRequest>>,
  respond: (req: Request) => Response,
) =>
  Layer.effect(
    FetchHttpClient.Fetch,
    Effect.succeed(((input: string, init?: RequestInit) => {
      const req = new Request(input, init);
      return req.formData().then((formData) => {
        const formEntries: Record<string, string> = {};
        formData.forEach((v, k) => {
          formEntries[k] = typeof v === "string" ? v : `[Blob:${v.type}]`;
        });
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        Effect.runSync(
          Ref.update(captured, (arr) => [
            ...arr,
            { url: req.url, method: req.method, headers, formEntries },
          ]),
        );
        return respond(req);
      });
    }) as typeof globalThis.fetch),
  );

const testLayer = (
  captured: Ref.Ref<ReadonlyArray<CapturedRequest>>,
  respond: (req: Request) => Response,
) =>
  MailgunSend.make({
    provider: "mailgun" as const,
    apiKey: "test-key",
    domain: "mg.example.com",
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(makeMockFetch(captured, respond)));

describe("MailgunSend Provider", () => {
  it("should POST raw MIME as FormData to Mailgun API with correct auth", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(
        captured,
        () => new Response(JSON.stringify({ id: "<msg-id@mg.example.com>" }), { status: 200 }),
      );
      const provider = yield* Effect.provide(SendProvider, layer);
      yield* provider.send(rawMime, envelope);
      const result = yield* Ref.get(captured);
      expect(result).toHaveLength(1);
      const [req] = result;
      if (!req) throw new Error("expected 1 request");
      expect(req.url).toBe("https://api.mailgun.net/v3/mg.example.com/messages.mime");
      expect(req.method).toBe("POST");
      expect(req.headers["authorization"]).toBe(`Basic ${btoa("api:test-key")}`);
      expect(req.formEntries["to"]).toBe("bob@example.com,carol@example.com");
      expect(req.formEntries["message"]).toMatch(/^\[Blob:/);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with SendError on 4xx response", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(
        captured,
        () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 401 }),
      );
      const provider = yield* Effect.provide(SendProvider, layer);
      const result = yield* provider.send(rawMime, envelope).pipe(Effect.flip);
      expect(result).toBeInstanceOf(SendError);
      expect(result._tag).toBe("SendError");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with SendError on 5xx response", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(
        captured,
        () => new Response("Internal Server Error", { status: 500 }),
      );
      const provider = yield* Effect.provide(SendProvider, layer);
      const result = yield* provider.send(rawMime, envelope).pipe(Effect.flip);
      expect(result).toBeInstanceOf(SendError);
    }).pipe(Effect.scoped, Effect.runPromise));
});
