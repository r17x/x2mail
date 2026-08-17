/**
 * @module receive.gmail.test
 * Level 2 provider test — proves GmailReceive by swapping HttpClient via mock fetch.
 */

import { DateTime, Effect, Layer, Ref } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, it } from "bun:test";
import { FetchError } from "./error.ts";
import { ReceiveProvider } from "./receive.ts";
import type { MessageId } from "./schema.ts";
import * as GmailReceive from "./receive.gmail.ts";

const testConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  refreshToken: "test-refresh-token",
} as const;

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
};

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
      const bodyPromise = req.method !== "GET" ? req.clone().text() : Promise.resolve(undefined);
      return bodyPromise.then((body) => {
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
  GmailReceive.make(testConfig).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(makeMockFetch(captured, respond)),
  );

const tokenBody = (expiresIn = 3600) =>
  JSON.stringify({ access_token: "test-access-token", expires_in: expiresIn });

const gmailListBody = (ids: ReadonlyArray<string>, nextPageToken?: string) =>
  JSON.stringify({
    messages: ids.length > 0 ? ids.map((id) => ({ id })) : undefined,
    resultSizeEstimate: ids.length,
    ...(nextPageToken ? { nextPageToken } : {}),
  });

const emptyListBody = () => JSON.stringify({ resultSizeEstimate: 0 });

const base64UrlEncode = (data: Uint8Array) => {
  const binary = Array.from(data, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const emailContent = new TextEncoder().encode("From: test@example.com\r\nSubject: hi\r\n\r\nHello");
const encodedEmail = base64UrlEncode(emailContent);

const gmailMessageBody = (id: string, internalDate = "1706000000000") =>
  JSON.stringify({ id, raw: encodedEmail, internalDate });

describe("GmailReceive Provider", () => {
  it("should refresh token and fetch messages", () => {
    const since = DateTime.makeUnsafe("2026-01-15T00:00:00Z");

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        if (req.url === "https://oauth2.googleapis.com/token") {
          return new Response(tokenBody(), { status: 200 });
        }
        if (req.url.includes("/messages?") || req.url.includes("/messages?q=")) {
          return new Response(gmailListBody(["msg-1"]), { status: 200 });
        }
        if (req.url.includes("/messages/msg-1?format=raw")) {
          return new Response(gmailMessageBody("msg-1"), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const messages = yield* provider.fetch(since);
      const reqs = yield* Ref.get(captured);

      expect(messages).toHaveLength(1);
      const [first] = messages;
      if (!first) throw new Error("expected 1 message");
      expect(first.id).toBe("msg-1" as MessageId);
      expect(first.raw).toEqual(emailContent);

      const tokenReq = reqs.find((r) => r.url.includes("oauth2.googleapis.com"));
      if (!tokenReq) throw new Error("expected token request");
      expect(tokenReq.method).toBe("POST");
      expect(tokenReq.body).toContain("grant_type=refresh_token");
      expect(tokenReq.body).toContain("client_id=test-client-id");

      const listReq = reqs.find((r) => r.url.includes("/messages?"));
      if (!listReq) throw new Error("expected list request");
      expect(listReq.headers["authorization"]).toBe("Bearer test-access-token");
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should reuse cached token when not expired", () => {
    const since = DateTime.makeUnsafe("2026-01-15T00:00:00Z");

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        if (req.url === "https://oauth2.googleapis.com/token") {
          return new Response(tokenBody(), { status: 200 });
        }
        if (req.url.includes("/messages?") || req.url.includes("/messages?q=")) {
          return new Response(gmailListBody(["msg-1"]), { status: 200 });
        }
        if (req.url.includes("?format=raw")) {
          return new Response(gmailMessageBody("msg-1"), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      yield* provider.fetch(since);
      yield* provider.fetch(since);
      const reqs = yield* Ref.get(captured);

      const tokenReqs = reqs.filter((r) => r.url.includes("oauth2.googleapis.com"));
      expect(tokenReqs).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should handle empty message list", () => {
    const since = DateTime.makeUnsafe("2026-01-15T00:00:00Z");

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        if (req.url === "https://oauth2.googleapis.com/token") {
          return new Response(tokenBody(), { status: 200 });
        }
        if (req.url.includes("/messages?") || req.url.includes("/messages?q=")) {
          return new Response(emptyListBody(), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(since);

      expect(result).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should paginate message list", () => {
    const since = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        if (req.url === "https://oauth2.googleapis.com/token") {
          return new Response(tokenBody(), { status: 200 });
        }
        if (req.url.includes("/messages?") || req.url.includes("/messages?q=")) {
          const url = new URL(req.url);
          if (!url.searchParams.has("pageToken")) {
            return new Response(gmailListBody(["msg-1"], "page-2-token"), { status: 200 });
          }
          return new Response(gmailListBody(["msg-2"]), { status: 200 });
        }
        if (req.url.includes("/messages/msg-1?format=raw")) {
          return new Response(gmailMessageBody("msg-1"), { status: 200 });
        }
        if (req.url.includes("/messages/msg-2?format=raw")) {
          return new Response(gmailMessageBody("msg-2"), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(since);

      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(["msg-1" as MessageId, "msg-2" as MessageId]);
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should decode base64url raw messages", () => {
    const rawContent = new TextEncoder().encode("Subject: Test\r\n\r\nBody with +/= chars");
    const encoded = base64UrlEncode(rawContent);
    const since = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

    return Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        if (req.url === "https://oauth2.googleapis.com/token") {
          return new Response(tokenBody(), { status: 200 });
        }
        if (req.url.includes("/messages?") || req.url.includes("/messages?q=")) {
          return new Response(gmailListBody(["msg-b64"]), { status: 200 });
        }
        if (req.url.includes("?format=raw")) {
          return new Response(
            JSON.stringify({ id: "msg-b64", raw: encoded, internalDate: "1706000000000" }),
            { status: 200 },
          );
        }
        return new Response("Not found", { status: 404 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(since);

      const [first] = result;
      if (!first) throw new Error("expected 1 message");
      expect(first.raw).toEqual(rawContent);
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("should trash message on remove", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        if (req.url === "https://oauth2.googleapis.com/token") {
          return new Response(tokenBody(), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      yield* provider.remove("msg-to-trash" as MessageId);
      const result = yield* Ref.get(captured);

      const trashReq = result.find((r) => r.url.includes("/trash"));
      if (!trashReq) throw new Error("expected trash request");
      expect(trashReq.method).toBe("POST");
      expect(trashReq.url).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-to-trash/trash",
      );
      expect(trashReq.headers["authorization"]).toBe("Bearer test-access-token");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with FetchError on token refresh failure", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, () => new Response("Unauthorized", { status: 401 }));
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(DateTime.makeUnsafe(0)).pipe(Effect.flip);

      expect(result).toBeInstanceOf(FetchError);
      expect(result._tag).toBe("FetchError");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("should fail with FetchError on API error", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
      const layer = testLayer(captured, (req) => {
        if (req.url === "https://oauth2.googleapis.com/token") {
          return new Response(tokenBody(), { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      });
      const provider = yield* Effect.provide(ReceiveProvider, layer);
      const result = yield* provider.fetch(DateTime.makeUnsafe(0)).pipe(Effect.flip);

      expect(result).toBeInstanceOf(FetchError);
      expect(result._tag).toBe("FetchError");
    }).pipe(Effect.scoped, Effect.runPromise));
});
