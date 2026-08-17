/**
 * @module receive.r2.test
 * Level 2 provider test — proves R2Receive by swapping HttpClient via mock fetch.
 */

import { DateTime, Effect, Layer, Ref } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, it } from "bun:test";
import { FetchError } from "./error.ts";
import { ReceiveProvider } from "./receive.ts";
import type { MessageId } from "./schema.ts";
import * as R2Receive from "./receive.r2.ts";

const testConfig = {
  accountId: "test-account-id",
  apiToken: "test-api-token",
  bucket: "test-bucket",
} as const;

const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${testConfig.accountId}/r2/buckets/${testConfig.bucket}/objects`;

type CapturedRequest = { url: string; method: string; headers: Record<string, string> };

const makeMockFetch = (
  captured: Ref.Ref<ReadonlyArray<CapturedRequest>>,
  respond: (req: Request) => Response,
) =>
  Layer.effect(
    FetchHttpClient.Fetch,
    Effect.succeed(((input: string, init?: RequestInit) => {
      const req = new Request(input, init);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      Effect.runSync(
        Ref.update(captured, (arr) => [...arr, { url: req.url, method: req.method, headers }]),
      );
      return Promise.resolve(respond(req));
    }) as typeof globalThis.fetch),
  );

const testLayer = (
  captured: Ref.Ref<ReadonlyArray<CapturedRequest>>,
  respond: (req: Request) => Response,
) =>
  R2Receive.make(testConfig).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(makeMockFetch(captured, respond)),
  );

const r2ListBody = (
  objects: ReadonlyArray<{ key: string; uploaded: string; size: number }>,
  truncated = false,
  cursor?: string,
) =>
  JSON.stringify({
    success: true,
    result: objects,
    result_info: { truncated, ...(cursor ? { cursor } : {}) },
  });

const emailContent = new TextEncoder().encode("From: test@example.com\r\nSubject: hi\r\n\r\nHello");

describe("R2Receive Provider", () => {
  it("should list and fetch R2 objects filtered by date", () => {
    const since = DateTime.makeUnsafe("2026-01-15T00:00:00Z");

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        if (req.method === "GET" && !req.url.includes("/objects/")) {
          return new Response(
            r2ListBody([
              { key: "msg-old", uploaded: "2026-01-10T00:00:00Z", size: 100 },
              { key: "msg-new", uploaded: "2026-01-20T00:00:00Z", size: 200 },
            ]),
            { status: 200 },
          );
        }
        return new Response(emailContent, { status: 200 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const messages = yield* provider.fetch(since);
      const reqs = yield* Ref.get(captured);
      expect(messages).toHaveLength(1);
      const [first] = messages;
      if (!first) throw new Error("expected 1 message");
      expect(first.id).toBe("msg-new" as MessageId);
      expect(first.raw).toEqual(emailContent);
      expect(first.receivedAt).toEqual(DateTime.makeUnsafe("2026-01-20T00:00:00Z"));

      const listReq = reqs.find((r) => r.method === "GET" && !r.url.includes("/objects/"));
      if (!listReq) throw new Error("expected list request");
      expect(listReq.headers["authorization"]).toBe("Bearer test-api-token");

      const fetchReq = reqs.find((r) => r.url.includes("/objects/msg-new"));
      if (!fetchReq) throw new Error("expected fetch request");
      expect(fetchReq.method).toBe("GET");
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should handle pagination with cursor", () => {
    const since = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        if (req.method === "GET" && !req.url.includes("/objects/")) {
          const url = new URL(req.url);
          if (!url.searchParams.has("cursor")) {
            return new Response(
              r2ListBody(
                [{ key: "msg-1", uploaded: "2026-01-05T00:00:00Z", size: 100 }],
                true,
                "cursor-page-2",
              ),
              { status: 200 },
            );
          }
          return new Response(
            r2ListBody([{ key: "msg-2", uploaded: "2026-01-06T00:00:00Z", size: 150 }]),
            { status: 200 },
          );
        }
        return new Response(emailContent, { status: 200 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(since);
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(["msg-1" as MessageId, "msg-2" as MessageId]);
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should delete object on remove", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, () => new Response(null, { status: 204 }));
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      yield* provider.remove("msg-to-delete" as MessageId);
      const result = yield* Ref.get(captured);
      expect(result).toHaveLength(1);
      const [req] = result;
      if (!req) throw new Error("expected 1 request");
      expect(req.method).toBe("DELETE");
      expect(req.url).toBe(`${baseUrl}/msg-to-delete`);
      expect(req.headers["authorization"]).toBe("Bearer test-api-token");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should URL-encode object keys on remove", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, () => new Response(null, { status: 204 }));
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      yield* provider.remove("path/with spaces" as MessageId);
      const result = yield* Ref.get(captured);
      const [req] = result;
      if (!req) throw new Error("expected 1 request");
      expect(req.url).toBe(`${baseUrl}/${encodeURIComponent("path/with spaces")}`);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with FetchError on list API error", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(
        captured,
        () =>
          new Response(JSON.stringify({ success: false, errors: [{ message: "Unauthorized" }] }), {
            status: 403,
          }),
      );
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(DateTime.makeUnsafe(0)).pipe(Effect.flip);
      expect(result).toBeInstanceOf(FetchError);
      expect(result._tag).toBe("FetchError");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with FetchError on delete API error", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, () => new Response("Forbidden", { status: 403 }));
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.remove("msg-forbidden" as MessageId).pipe(Effect.flip);
      expect(result).toBeInstanceOf(FetchError);
      expect(result._tag).toBe("FetchError");
    }).pipe(Effect.scoped, Effect.runPromise));
});
