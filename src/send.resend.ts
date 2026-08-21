/**
 * @module send.resend
 * @description Resend provider — sends raw MIME via Resend HTTP API.
 */

import { Effect, Layer, Schedule } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { SendError } from "./error";
import type { ResendSendConfig } from "./schema";
import { SendProvider } from "./send";

export const make = (config: typeof ResendSendConfig.Type) =>
  Layer.effect(
    SendProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const resend = client.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(config.apiKey)),
        HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 3 }),
        HttpClient.filterStatusOk,
      );

      return SendProvider.of({
        send: Effect.fn("SendProvider.send.resend")(
          function* (raw, _envelope) {
            yield* resend.post("https://api.resend.com/emails", {
              body: HttpBody.uint8Array(raw, "message/rfc822"),
            });
          },
          (E) =>
            E.pipe(
              Effect.tapErrorTag("HttpClientError", (e) =>
                Effect.logWarning("resend API error", { cause: e }),
              ),
              Effect.catchTag("HttpClientError", (e) =>
                Effect.fail(new SendError({ message: `Resend API error: ${e.message}`, cause: e })),
              ),
            ),
        ),
      });
    }),
  );
