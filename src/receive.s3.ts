/**
 * @module receive.s3
 * @description S3 receive provider — fetches emails from AWS S3 bucket with SigV4 auth.
 */

import { Array as Arr, DateTime, Effect, Layer, Option, Schedule, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { signRequest } from "./aws.sigv4.ts";
import { FetchError } from "./error.ts";
import { ReceiveProvider } from "./receive.ts";
import type { InboxMessage, MessageId, S3ReceiveConfig } from "./schema.ts";

const xmlTag = (xml: string, tag: string) => {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1] ?? null;
};

const xmlTagAll = (xml: string, tag: string) =>
  Array.from(xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")), (m) => m[1] ?? "");

const parseListResponse = (xml: string) => {
  const objects = xmlTagAll(xml, "Contents").map((block) => ({
    key: xmlTag(block, "Key") ?? "",
    lastModified: xmlTag(block, "LastModified") ?? "",
    size: parseInt(xmlTag(block, "Size") ?? "0", 10),
  }));
  const token = xmlTag(xml, "NextContinuationToken");
  const truncated = xmlTag(xml, "IsTruncated") === "true";
  return { objects, token, truncated };
};

export const make = (config: typeof S3ReceiveConfig.Type) =>
  Layer.effect(
    ReceiveProvider,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;

      const s3client = baseClient.pipe(
        HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 3 }),
        HttpClient.filterStatusOk,
      );

      const baseUrl = `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
      const credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };

      const signedRequest = (method: string, urlStr: string) =>
        Effect.gen(function* () {
          const url = new URL(urlStr);
          const signed = yield* signRequest({
            method,
            url,
            headers: {},
            body: "",
            credentials,
            region: config.region,
            service: "s3",
          });
          return { headers: signed };
        });

      const listPage = (continuationToken: string | undefined | null) =>
        Effect.gen(function* () {
          const url = new URL(baseUrl);
          url.searchParams.set("list-type", "2");
          url.searchParams.set("prefix", "emails/");
          if (continuationToken) {
            url.searchParams.set("continuation-token", continuationToken);
          }
          const opts = yield* signedRequest("GET", url.toString());
          const res = yield* s3client.get(url.toString(), { headers: opts.headers });
          const text = yield* res.text;
          return parseListResponse(text);
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) => new FetchError({ message: "S3 list objects failed", cause })),
        );

      const listAll = Stream.paginate(undefined as string | undefined | null, (token) =>
        Effect.map(listPage(token), (page) => [
          page.objects,
          page.truncated ? Option.some(page.token) : Option.none(),
        ]),
      ).pipe(Stream.runCollect);

      const fetchObject = (key: string) =>
        Effect.gen(function* () {
          const urlStr = `${baseUrl}/${encodeURIComponent(key)}`;
          const opts = yield* signedRequest("GET", urlStr);
          const res = yield* s3client.get(urlStr, { headers: opts.headers });
          const buf = yield* res.arrayBuffer;
          return new Uint8Array(buf);
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            (cause) => new FetchError({ message: `S3 get object failed: ${key}`, cause }),
          ),
        );

      return ReceiveProvider.of({
        fetch: Effect.fn("ReceiveProvider.fetch.s3")(function* (since) {
          const objects = yield* listAll;
          const sinceMs = DateTime.toEpochMillis(since);
          const filtered = Arr.filter(
            objects,
            (obj) => DateTime.toEpochMillis(DateTime.makeUnsafe(obj.lastModified)) > sinceMs,
          );
          return yield* Effect.forEach(filtered, (obj) =>
            Effect.gen(function* () {
              const raw = yield* fetchObject(obj.key);
              return {
                id: obj.key as MessageId,
                raw,
                receivedAt: DateTime.makeUnsafe(obj.lastModified),
              } satisfies InboxMessage;
            }),
          );
        }),

        remove: Effect.fn("ReceiveProvider.remove.s3")(function* (id) {
          const urlStr = `${baseUrl}/${encodeURIComponent(id)}`;
          const opts = yield* signedRequest("DELETE", urlStr);
          yield* s3client.del(urlStr, { headers: opts.headers }).pipe(
            Effect.scoped,
            Effect.mapError(
              (cause) => new FetchError({ message: `S3 delete object failed: ${id}`, cause }),
            ),
          );
        }),
      });
    }),
  );
