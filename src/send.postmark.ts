/**
 * @module send.postmark
 * @description Postmark provider — sends raw MIME as base64 JSON via Postmark HTTP API.
 */

import { Effect, Layer, Schedule, Schema } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { SendError } from "./error.ts";
import type { MessageId } from "./schema.ts";
import { SendProvider } from "./send.ts";

const PostmarkResponse = Schema.Struct({ MessageID: Schema.String });

export const make = (serverToken: string) =>
  Layer.effect(
    SendProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const postmark = client.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("X-Postmark-Server-Token", serverToken)),
        HttpClient.mapRequest(HttpClientRequest.accept("application/json")),
        HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 3 }),
        HttpClient.filterStatusOk,
      );

      return SendProvider.of({
        send: (raw, _envelope) =>
          postmark
            .post("https://api.postmarkapp.com/email/rawMessage", {
              body: HttpBody.jsonUnsafe({ RawEmailContent: Buffer.from(raw).toString("base64") }),
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(PostmarkResponse)),
              Effect.map(({ MessageID }) => ({ messageId: MessageID as MessageId })),
              Effect.tapErrorTag("HttpClientError", (e) => Effect.logWarning("postmark API error", { cause: e })),
              Effect.catchTags({
                HttpClientError: (e) =>
                  Effect.fail(
                    new SendError({ message: `Postmark API error: ${e.message}`, cause: e }),
                  ),
                SchemaError: (e) =>
                  Effect.fail(
                    new SendError({
                      message: `Postmark response decode failed: ${e.message}`,
                      cause: e,
                    }),
                  ),
              }),
            ),
      });
    }),
  );
