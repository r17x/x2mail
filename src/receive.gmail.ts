/**
 * @module receive.gmail
 * Gmail API receive provider — fetches emails via Gmail REST API with OAuth2.
 */

import { DateTime, Effect, Layer, Ref, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { FetchError } from "./error.ts";
import { ReceiveProvider } from "./receive.ts";
import type { InboxMessage, MessageId } from "./schema.ts";

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Finite,
});

const GmailListResponse = Schema.Struct({
  messages: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  nextPageToken: Schema.optional(Schema.String),
});

const GmailMessageResponse = Schema.Struct({
  id: Schema.String,
  raw: Schema.String,
  internalDate: Schema.optional(Schema.String),
});

const base64UrlDecode = (s: string) => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const paddedFull = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return new Uint8Array(Array.from(atob(paddedFull), (c) => c.charCodeAt(0)));
};

export const make = (config: { clientId: string; clientSecret: string; refreshToken: string }) =>
  Layer.effect(
    ReceiveProvider,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;
      const tokenRef = yield* Ref.make({ token: "", expiresAt: DateTime.makeUnsafe(0) });

      const refreshAccessToken = Effect.gen(function* () {
        const { expiresAt } = yield* Ref.get(tokenRef);
        const now = yield* DateTime.now;
        if (DateTime.toEpochMillis(expiresAt) > DateTime.toEpochMillis(now)) return;

        const res = yield* baseClient
          .post("https://oauth2.googleapis.com/token", {
            body: HttpBody.urlParams({
              grant_type: "refresh_token",
              client_id: config.clientId,
              client_secret: config.clientSecret,
              refresh_token: config.refreshToken,
            }),
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
            Effect.scoped,
            Effect.mapError(
              (cause) => new FetchError({ message: "Gmail token refresh failed", cause }),
            ),
          );

        const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
        yield* Ref.set(tokenRef, {
          token: res.access_token,
          expiresAt: DateTime.makeUnsafe(nowMs + (res.expires_in - 60) * 1000),
        });
      });

      const authedGet = (url: string) =>
        Effect.gen(function* () {
          yield* refreshAccessToken;
          const { token } = yield* Ref.get(tokenRef);
          return yield* baseClient.get(url, {
            headers: { authorization: `Bearer ${token}` },
          });
        });

      const authedPost = (url: string) =>
        Effect.gen(function* () {
          yield* refreshAccessToken;
          const { token } = yield* Ref.get(tokenRef);
          return yield* baseClient.post(url, {
            headers: { authorization: `Bearer ${token}` },
          });
        });

      const listPage = (epoch: number, pageToken: string | undefined) =>
        authedGet(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=after:${epoch}${pageToken ? `&pageToken=${pageToken}` : ""}`,
        ).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(GmailListResponse)),
          Effect.scoped,
          Effect.mapError(
            (cause) => new FetchError({ message: "Gmail list messages failed", cause }),
          ),
        );

      const listAll = (epoch: number) => {
        const loop = (
          accumulated: ReadonlyArray<{ id: string }>,
          pageToken: string | undefined,
        ): Effect.Effect<ReadonlyArray<{ id: string }>, FetchError> =>
          Effect.gen(function* () {
            const page = yield* listPage(epoch, pageToken);
            const all = [...accumulated, ...(page.messages ?? [])];
            if (!page.nextPageToken) return all;
            return yield* loop(all, page.nextPageToken);
          });
        return loop([], undefined);
      };

      const fetchMessage = (id: string) =>
        authedGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=raw`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(GmailMessageResponse)),
          Effect.scoped,
          Effect.mapError(
            (cause) => new FetchError({ message: `Gmail get message failed: ${id}`, cause }),
          ),
        );

      return ReceiveProvider.of({
        fetch: (since) =>
          Effect.gen(function* () {
            const epoch = Math.floor(DateTime.toEpochMillis(since) / 1000);
            const messageIds = yield* listAll(epoch);
            return yield* Effect.forEach(messageIds, (msg) =>
              Effect.gen(function* () {
                const detail = yield* fetchMessage(msg.id);
                return {
                  id: detail.id as MessageId,
                  raw: base64UrlDecode(detail.raw),
                  receivedAt:
                    detail.internalDate && !Number.isNaN(Number(detail.internalDate))
                      ? DateTime.makeUnsafe(Number(detail.internalDate))
                      : since,
                } satisfies InboxMessage;
              }),
            );
          }).pipe(
            Effect.mapError((cause) => new FetchError({ message: "Gmail fetch failed", cause })),
          ),

        remove: (id) =>
          authedPost(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`).pipe(
            Effect.asVoid,
            Effect.scoped,
            Effect.mapError(
              (cause) => new FetchError({ message: `Gmail trash failed: ${id}`, cause }),
            ),
          ),
      });
    }),
  );
