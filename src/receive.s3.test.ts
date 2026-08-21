/**
 * @module receive.s3.test
 * Level 2 provider test — proves S3Receive by swapping HttpClient via mock fetch.
 */

import { DateTime, Effect, Layer, Ref } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, it } from "bun:test";
import { FetchError } from "./error";
import { ReceiveProvider } from "./receive";
import type { MessageId } from "./schema";
import * as S3Receive from "./receive.s3";

const testConfig = {
  provider: "s3" as const,
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  bucket: "test-bucket",
} as const;

const baseUrl = `https://${testConfig.bucket}.s3.${testConfig.region}.amazonaws.com`;

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
  S3Receive.make(testConfig).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(makeMockFetch(captured, respond)),
  );

const s3ListXml = (
  objects: ReadonlyArray<{ key: string; lastModified: string; size: number }>,
  truncated = false,
  nextToken?: string,
) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>${truncated}</IsTruncated>
  ${nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ""}
  ${objects.map((o) => `<Contents><Key>${o.key}</Key><LastModified>${o.lastModified}</LastModified><Size>${o.size}</Size></Contents>`).join("\n  ")}
</ListBucketResult>`;

const emailContent = new TextEncoder().encode("From: test@example.com\r\nSubject: hi\r\n\r\nHello");

describe("S3Receive Provider", () => {
  it("should list and fetch S3 objects filtered by date", () => {
    const since = DateTime.makeUnsafe("2026-01-15T00:00:00Z");

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        const url = new URL(req.url);
        if (req.method === "GET" && url.searchParams.has("list-type")) {
          return new Response(
            s3ListXml([
              { key: "emails/msg-old", lastModified: "2026-01-10T00:00:00Z", size: 100 },
              { key: "emails/msg-new", lastModified: "2026-01-20T00:00:00Z", size: 200 },
            ]),
            { status: 200, headers: { "content-type": "application/xml" } },
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
      expect(first.id).toBe("emails/msg-new" as MessageId);
      expect(first.raw).toEqual(emailContent);
      expect(first.receivedAt).toEqual(DateTime.makeUnsafe("2026-01-20T00:00:00Z"));

      const listReq = reqs.find((r) => r.url.includes("list-type"));
      if (!listReq) throw new Error("expected list request");
      expect(listReq.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(listReq.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should handle pagination with continuation token", () => {
    const since = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        const url = new URL(req.url);
        if (req.method === "GET" && url.searchParams.has("list-type")) {
          if (!url.searchParams.has("continuation-token")) {
            return new Response(
              s3ListXml(
                [{ key: "emails/msg-1", lastModified: "2026-01-05T00:00:00Z", size: 100 }],
                true,
                "token-page-2",
              ),
              { status: 200 },
            );
          }
          return new Response(
            s3ListXml([{ key: "emails/msg-2", lastModified: "2026-01-06T00:00:00Z", size: 150 }]),
            { status: 200 },
          );
        }
        return new Response(emailContent, { status: 200 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(since);

      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual([
        "emails/msg-1" as MessageId,
        "emails/msg-2" as MessageId,
      ]);
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should delete object on remove", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, () => new Response(null, { status: 204 }));
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      yield* provider.remove("emails/msg-to-delete" as MessageId);
      const result = yield* Ref.get(captured);

      expect(result).toHaveLength(1);
      const [req] = result;
      if (!req) throw new Error("expected 1 request");
      expect(req.method).toBe("DELETE");
      expect(req.url).toBe(`${baseUrl}/${encodeURIComponent("emails/msg-to-delete")}`);
      expect(req.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with FetchError on API error", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(
        captured,
        () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
      );
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(DateTime.makeUnsafe(0)).pipe(Effect.flip);

      expect(result).toBeInstanceOf(FetchError);
      expect(result._tag).toBe("FetchError");
    }).pipe(Effect.scoped, Effect.runPromise));
});
