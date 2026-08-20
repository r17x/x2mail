/**
 * @module receive.gmail
 * Gmail API receive provider — fetches emails via Gmail REST API with OAuth2.
 */

import { DateTime, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { FetchError } from "./error.ts";
import { ReceiveProvider } from "./receive.ts";
import type { GmailReceiveConfig, InboxMessage, MessageId } from "./schema.ts";

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
  internalDate: Schema.optional(Schema.FiniteFromString),
});

export const make = (config: typeof GmailReceiveConfig.Type) =>
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

      const listAll = (epoch: number) =>
        Stream.paginate(
          undefined as string | undefined,
          Effect.fn(function* (pageToken) {
            const page = yield* listPage(epoch, pageToken);
            const ids = page.messages ?? [];
            return [
              ids,
              page.nextPageToken ? Option.some(page.nextPageToken) : Option.none<string>(),
            ] as const;
          }),
        ).pipe(Stream.runCollect);

      const fetchMessage = (id: string) =>
        authedGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=raw`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(GmailMessageResponse)),
          Effect.scoped,
          Effect.mapError(
            (cause) => new FetchError({ message: `Gmail get message failed: ${id}`, cause }),
          ),
        );

      return ReceiveProvider.of({
        fetch: Effect.fn("ReceiveProvider.fetch.gmail")(
          function* (since) {
            const epoch = Math.floor(DateTime.toEpochMillis(since) / 1000);
            const messageIds = yield* listAll(epoch);
            return yield* Effect.forEach(messageIds, (msg) =>
              Effect.gen(function* () {
                const detail = yield* fetchMessage(msg.id);
                return {
                  id: detail.id as MessageId,
                  raw: Buffer.from(detail.raw, "base64url"),
                  receivedAt: detail.internalDate !== undefined
                    ? DateTime.makeUnsafe(detail.internalDate)
                    : since,
                } satisfies InboxMessage;
              }),
            );
          },
          (E) =>
            E.pipe(
              Effect.mapError(
                (cause) => new FetchError({ message: "Gmail fetch failed", cause }),
              ),
            ),
        ),

        remove: Effect.fn("ReceiveProvider.remove.gmail")(function* (id) {
          yield* authedPost(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`,
          ).pipe(
            Effect.scoped,
            Effect.mapError(
              (cause) => new FetchError({ message: `Gmail trash failed: ${id}`, cause }),
            ),
          );
        }),
      });
    }),
  );
