/**
 * @module send.resend.test
 * Level 2 provider test — proves ResendSend by swapping HttpClient via mock fetch.
 */

import { Effect, Layer, Ref } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, it } from "bun:test";
import { SendError } from "./error.ts";
import type { Email } from "./schema.ts";
import { SendProvider } from "./send.ts";
import * as ResendSend from "./send.resend.ts";

const encoder = new TextEncoder();

const rawMime = encoder.encode(
  "From: alice@example.com\r\nTo: bob@example.com\r\nSubject: hi\r\n\r\nHello",
);

const envelope = { from: "alice@example.com" as Email, to: ["bob@example.com" as Email] } as const;

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
};

const makeMockFetch = (
  captured: Ref.Ref<ReadonlyArray<CapturedRequest>>,
  respond: (req: Request) => Response,
) =>
  Layer.effect(
    FetchHttpClient.Fetch,
    Effect.succeed(((input: string, init?: RequestInit) => {
      const req = new Request(input, init);
      return req.arrayBuffer().then((buf) => {
        const body = new Uint8Array(buf);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        Effect.runSync(
          Ref.update(captured, (arr) => [
            ...arr,
            { url: req.url, method: req.method, headers, body },
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
  ResendSend.make({ provider: "resend" as const, apiKey: "re_test_api_key_123" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(makeMockFetch(captured, respond)),
  );

describe("ResendSend Provider", () => {
  it("should POST raw MIME to Resend API with correct headers", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(
        captured,
        () => new Response("", { status: 200 }),
      );
      const provider = yield* Effect.provide(SendProvider, layer);
      yield* provider.send(rawMime, envelope);
      const result = yield* Ref.get(captured);
      expect(result).toHaveLength(1);
      const [req] = result;
      if (!req) throw new Error("expected 1 request");
      expect(req.url).toBe("https://api.resend.com/emails");
      expect(req.method).toBe("POST");
      expect(req.headers["authorization"]).toBe("Bearer re_test_api_key_123");
      expect(req.headers["content-type"]).toContain("message/rfc822");
      expect(new TextDecoder().decode(req.body)).toBe(new TextDecoder().decode(rawMime));
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with SendError on 4xx response", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(
        captured,
        () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }),
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
