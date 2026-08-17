/**
 * @module receive.r2
 * @description R2 receive provider — fetches emails from Cloudflare R2 bucket via CF API.
 */

import { Array as Arr, DateTime, Effect, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { FetchError } from "./error.ts";
import { ReceiveProvider } from "./receive.ts";
import type { InboxMessage, MessageId } from "./schema.ts";

const R2Object = Schema.Struct({
  key: Schema.String,
  uploaded: Schema.String,
  size: Schema.Finite,
});

const R2ListResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Array(R2Object),
  result_info: Schema.Struct({
    cursor: Schema.optional(Schema.String),
    truncated: Schema.Boolean,
  }),
});

const decodeListResponse = HttpClientResponse.schemaBodyJson(R2ListResponse);

export const make = (config: { accountId: string; apiToken: string; bucket: string }) =>
  Layer.effect(
    ReceiveProvider,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;

      const client = baseClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(config.apiToken)),
        HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 3 }),
        HttpClient.filterStatusOk,
      );

      const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/r2/buckets/${config.bucket}/objects`;

      const listPage = (cursor: string | undefined) =>
        client
          .get(baseUrl, {
            urlParams: cursor ? [["cursor", cursor]] : [],
          })
          .pipe(
            Effect.flatMap(decodeListResponse),
            Effect.scoped,
            Effect.mapError(
              (cause) => new FetchError({ message: "R2 list objects failed", cause }),
            ),
          );

      const listAll = (() => {
        const loop = (
          accumulated: ReadonlyArray<typeof R2Object.Type>,
          cursor: string | undefined,
        ): Effect.Effect<ReadonlyArray<typeof R2Object.Type>, FetchError> =>
          Effect.gen(function* () {
            const page = yield* listPage(cursor);
            const all = [...accumulated, ...page.result];
            if (!page.result_info.truncated) return all;
            return yield* loop(all, page.result_info.cursor);
          });
        return loop([], undefined);
      })();

      const fetchObject = (key: string) =>
        client.get(`${baseUrl}/${encodeURIComponent(key)}`).pipe(
          Effect.flatMap((res) => res.arrayBuffer),
          Effect.map((buf) => new Uint8Array(buf)),
          Effect.scoped,
          Effect.mapError(
            (cause) => new FetchError({ message: `R2 get object failed: ${key}`, cause }),
          ),
        );

      return ReceiveProvider.of({
        fetch: (since) =>
          Effect.gen(function* () {
            const objects = yield* listAll;
            const sinceMs = DateTime.toEpochMillis(since);
            const filtered = Arr.filter(
              objects,
              (obj) => DateTime.toEpochMillis(DateTime.makeUnsafe(obj.uploaded)) > sinceMs,
            );
            return yield* Effect.forEach(filtered, (obj) =>
              Effect.gen(function* () {
                const raw = yield* fetchObject(obj.key);
                return {
                  id: obj.key as MessageId,
                  raw,
                  receivedAt: DateTime.makeUnsafe(obj.uploaded),
                } satisfies InboxMessage;
              }),
            );
          }),

        remove: (id) =>
          client.del(`${baseUrl}/${encodeURIComponent(id)}`).pipe(
            Effect.asVoid,
            Effect.scoped,
            Effect.mapError(
              (cause) => new FetchError({ message: `R2 delete object failed: ${id}`, cause }),
            ),
          ),
      });
    }),
  );
