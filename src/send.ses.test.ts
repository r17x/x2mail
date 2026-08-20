/**
 * @module send.ses.test
 * Level 2 provider test — proves SesSend by swapping HttpClient via mock fetch.
 */

import { Effect, Layer, Ref, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, it } from "bun:test";
import { SendError } from "./error.ts";
import type { Email } from "./schema.ts";
import { SendProvider } from "./send.ts";
import * as SesSend from "./send.ses.ts";

const encoder = new TextEncoder();

const rawMime = encoder.encode(
  "From: alice@example.com\r\nTo: bob@example.com\r\nSubject: hi\r\n\r\nHello",
);

const envelope = { from: "alice@example.com" as Email, to: ["bob@example.com" as Email] } as const;

const testConfig = {
  provider: "ses" as const,
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
} as const;

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

const makeMockFetch = (
  captured: Ref.Ref<ReadonlyArray<CapturedRequest>>,
  respond: (req: Request) => Response,
) =>
  Layer.effect(
    FetchHttpClient.Fetch,
    Effect.succeed(((input: string, init?: RequestInit) => {
      const req = new Request(input, init);
      return req.text().then((body) => {
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
  SesSend.make(testConfig).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(makeMockFetch(captured, respond)),
  );

describe("SesSend Provider", () => {
  it("should POST to SES endpoint with SigV4 Authorization header", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(
        captured,
        () =>
          new Response(
            Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ MessageId: "ses_abc123" }),
            { status: 200 },
          ),
      );
      const provider = yield* Effect.provide(SendProvider, layer);
      yield* provider.send(rawMime, envelope);
      const result = yield* Ref.get(captured);
      expect(result).toHaveLength(1);
      const [req] = result;
      if (!req) throw new Error("expected 1 request");
      expect(req.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
      expect(req.method).toBe("POST");
      expect(req.headers["authorization"]).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//,
      );
      expect(req.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
      expect(req.headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
      expect(req.headers["content-type"]).toBe("application/json");

      const body = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            Content: Schema.Struct({ Raw: Schema.Struct({ Data: Schema.String }) }),
          }),
        ),
      )(req.body);
      expect(body.Content.Raw.Data).toBeDefined();
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with SendError on 4xx/5xx", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(
        captured,
        () =>
          new Response(
            Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
              message: "Invalid credentials",
            }),
            { status: 403 },
          ),
      );
      const provider = yield* Effect.provide(SendProvider, layer);
      const result = yield* provider.send(rawMime, envelope).pipe(Effect.flip);
      expect(result).toBeInstanceOf(SendError);
      expect(result._tag).toBe("SendError");
    }).pipe(Effect.scoped, Effect.runPromise));
});
