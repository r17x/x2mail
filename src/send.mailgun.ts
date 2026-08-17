/**
 * @module send.mailgun
 * Mailgun provider — sends raw MIME via Mailgun messages.mime API.
 */

import { Effect, Layer, Schedule, Schema } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { SendError } from "./error.ts";
import type { MessageId } from "./schema.ts";
import { SendProvider } from "./send.ts";

const MailgunResponse = Schema.Struct({ id: Schema.String });

export const make = (config: { apiKey: string; domain: string }) =>
  Layer.effect(
    SendProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const mailgun = client.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeader("Authorization", `Basic ${btoa("api:" + config.apiKey)}`),
        ),
        HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 3 }),
        HttpClient.filterStatusOk,
      );

      return SendProvider.of({
        send: (raw, envelope) =>
          mailgun
            .post(`https://api.mailgun.net/v3/${config.domain}/messages.mime`, {
              body: HttpBody.formDataRecord({
                to: envelope.to.join(","),
                message: new Blob([raw], { type: "message/rfc822" }),
              }),
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(MailgunResponse)),
              Effect.map(({ id }) => ({ messageId: id as MessageId })),
              Effect.tapErrorTag("HttpClientError", (e) =>
                Effect.logWarning("mailgun API error", { cause: e }),
              ),
              Effect.catchTags({
                HttpClientError: (e) =>
                  Effect.fail(
                    new SendError({ message: `Mailgun API error: ${e.message}`, cause: e }),
                  ),
                SchemaError: (e) =>
                  Effect.fail(
                    new SendError({
                      message: `Mailgun response decode failed: ${e.message}`,
                      cause: e,
                    }),
                  ),
              }),
            ),
      });
    }),
  );
