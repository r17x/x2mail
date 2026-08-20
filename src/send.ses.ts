/**
 * @module send.ses
 * @description SES v2 send provider — sends raw MIME via AWS SES HTTP API with SigV4 auth.
 */

import { Effect, Layer, Schedule, Schema } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { signRequest } from "./aws.sigv4.ts";
import { SendError } from "./error.ts";
import type { SesSendConfig } from "./schema.ts";
import { SendProvider } from "./send.ts";

export const make = (config: typeof SesSendConfig.Type) =>
  Layer.effect(
    SendProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const ses = client.pipe(
        HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 3 }),
        HttpClient.filterStatusOk,
      );

      const endpoint = `https://email.${config.region}.amazonaws.com/v2/email/outbound-emails`;

      return SendProvider.of({
        send: Effect.fn("SendProvider.send.ses")(
          function* (raw, _envelope) {
            const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              Content: { Raw: { Data: Buffer.from(raw).toString("base64") } },
            });
            const url = new URL(endpoint);
            const signed = yield* signRequest({
              method: "POST",
              url,
              headers: { "content-type": "application/json" },
              body,
              credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
              },
              region: config.region,
              service: "ses",
            });

            yield* ses.post(endpoint, {
              body: HttpBody.text(body, "application/json"),
              headers: signed,
            });
          },
          (E) =>
            E.pipe(
              Effect.tapErrorTag("HttpClientError", (e) =>
                Effect.logWarning("ses API error", { cause: e }),
              ),
              Effect.catchTags({
                HttpClientError: (e) =>
                  Effect.fail(new SendError({ message: `SES API error: ${e.message}`, cause: e })),
                SchemaError: (e) =>
                  Effect.fail(
                    new SendError({
                      message: `SES request encode failed: ${e.message}`,
                      cause: e,
                    }),
                  ),
              }),
            ),
        ),
      });
    }),
  );
