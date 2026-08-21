/**
 * @module receive.r2
 * @description R2 receive provider — fetches emails from Cloudflare R2 bucket via CF API.
 */

import { Array as Arr, DateTime, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { FetchError } from "./error";
import { ReceiveProvider } from "./receive";
import type { InboxMessage, MessageId, R2ReceiveConfig } from "./schema";

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

export const make = (config: typeof R2ReceiveConfig.Type) =>
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

      const listAll = Stream.paginate(undefined as string | undefined, (cursor) =>
        Effect.map(listPage(cursor), (page) => [
          page.result,
          page.result_info.truncated ? Option.some(page.result_info.cursor) : Option.none(),
        ]),
      ).pipe(Stream.runCollect);

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
        fetch: Effect.fn("ReceiveProvider.fetch.r2")(function* (since) {
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

        remove: Effect.fn("ReceiveProvider.remove.r2")(function* (id) {
          yield* client.del(`${baseUrl}/${encodeURIComponent(id)}`).pipe(
            Effect.scoped,
            Effect.mapError(
              (cause) => new FetchError({ message: `R2 delete object failed: ${id}`, cause }),
            ),
          );
        }),
      });
    }),
  );
