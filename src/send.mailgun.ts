/**
 * @module send.mailgun
 * Mailgun provider — sends raw MIME via Mailgun messages.mime API.
 */

import { Effect, Layer, Schedule } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { SendError } from "./error";
import type { MailgunSendConfig } from "./schema";
import { SendProvider } from "./send";

export const make = (config: typeof MailgunSendConfig.Type) =>
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
        send: Effect.fn("SendProvider.send.mailgun")(
          function* (raw, envelope) {
            yield* mailgun.post(`https://api.mailgun.net/v3/${config.domain}/messages.mime`, {
              body: HttpBody.formDataRecord({
                to: envelope.to.join(","),
                message: new Blob([raw], { type: "message/rfc822" }),
              }),
            });
          },
          (E) =>
            E.pipe(
              Effect.tapErrorTag("HttpClientError", (e) =>
                Effect.logWarning("mailgun API error", { cause: e }),
              ),
              Effect.catchTag("HttpClientError", (e) =>
                Effect.fail(
                  new SendError({ message: `Mailgun API error: ${e.message}`, cause: e }),
                ),
              ),
            ),
        ),
      });
    }),
  );
