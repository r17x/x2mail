/**
 * @module send.resend
 * @description Resend provider — parses MIME into structured JSON and sends via Resend HTTP API.
 */

import { Array as A, Effect, Layer, Option as O, Schedule, Schema } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { SendError } from "./error.ts";
import type { MessageId } from "./schema.ts";
import { SendProvider } from "./send.ts";

const ResendResponse = Schema.Struct({ id: Schema.String });

const unfoldHeaders = (raw: string) =>
  A.reduce(raw.split(/\r?\n/), [] as ReadonlyArray<string>, (acc, line) =>
    /^\s/.test(line) && acc.length > 0
      ? [...acc.slice(0, -1), `${acc[acc.length - 1] ?? ""} ${line.trim()}`]
      : [...acc, line],
  );

const findHeader = (lines: ReadonlyArray<string>, name: string) =>
  A.findFirst(lines, (l) => l.toLowerCase().startsWith(name.toLowerCase() + ":")).pipe(
    O.map((l) => l.slice(name.length + 1).trim()),
  );

const decodeTransferEncoding = (body: string, encoding: string) => {
  const normalized = encoding.toLowerCase().trim();
  if (normalized === "base64") {
    const cleaned = body.replace(/\r?\n/g, "");
    return new TextDecoder().decode(Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0)));
  }
  if (normalized === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
};

const parsePartBody = (partRaw: string) => {
  const sepIdx = partRaw.indexOf("\r\n\r\n");
  if (sepIdx === -1) return { headers: [] as ReadonlyArray<string>, body: partRaw };
  const headers = unfoldHeaders(partRaw.slice(0, sepIdx));
  const body = partRaw.slice(sepIdx + 4);
  const encoding = findHeader(headers, "Content-Transfer-Encoding").pipe(O.getOrElse(() => ""));
  return { headers, body: decodeTransferEncoding(body, encoding) };
};

const parseMime = (raw: Uint8Array) => {
  const text = new TextDecoder().decode(raw);
  const splitIdx = text.indexOf("\r\n\r\n");
  const headerSection = splitIdx === -1 ? text : text.slice(0, splitIdx);
  const bodySection = splitIdx === -1 ? "" : text.slice(splitIdx + 4);
  const headerLines = unfoldHeaders(headerSection);
  const subject = findHeader(headerLines, "Subject").pipe(O.getOrElse(() => "(no subject)"));
  const contentType = findHeader(headerLines, "Content-Type").pipe(O.getOrElse(() => "text/plain"));
  const transferEncoding = findHeader(headerLines, "Content-Transfer-Encoding").pipe(
    O.getOrElse(() => ""),
  );

  if (/^multipart\/(alternative|mixed)/i.test(contentType)) {
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
    const boundary = boundaryMatch?.[1] ?? "";
    const parts = bodySection
      .split(`--${boundary}`)
      .slice(1)
      .filter((p) => !p.startsWith("--"))
      .map((p) => p.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));

    const parsed = parts.map(parsePartBody);
    const textPart = A.findFirst(parsed, (p) =>
      findHeader(p.headers, "Content-Type").pipe(
        O.map((ct) => ct.toLowerCase().startsWith("text/plain")),
        O.getOrElse(() => false),
      ),
    );
    const htmlPart = A.findFirst(parsed, (p) =>
      findHeader(p.headers, "Content-Type").pipe(
        O.map((ct) => ct.toLowerCase().startsWith("text/html")),
        O.getOrElse(() => false),
      ),
    );

    return {
      subject,
      ...(O.isSome(textPart) ? { text: textPart.value.body } : {}),
      ...(O.isSome(htmlPart) ? { html: htmlPart.value.body } : {}),
    };
  }

  const decodedBody = decodeTransferEncoding(bodySection, transferEncoding);

  if (/text\/html/i.test(contentType)) {
    return { subject, html: decodedBody };
  }
  return { subject, text: decodedBody };
};

export const make = (apiKey: string) =>
  Layer.effect(
    SendProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const resend = client.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(apiKey)),
        HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 3 }),
        HttpClient.filterStatusOk,
      );

      return SendProvider.of({
        send: (raw, envelope) =>
          Effect.gen(function* () {
            const mime = parseMime(raw);
            const payload = {
              from: envelope.from,
              to: envelope.to,
              ...mime,
            };
            const response = yield* resend.post("https://api.resend.com/emails", {
              body: HttpBody.jsonUnsafe(payload),
            });
            return yield* HttpClientResponse.schemaBodyJson(ResendResponse)(response);
          }).pipe(
            Effect.map(({ id }) => ({ messageId: id as MessageId })),
            Effect.tapErrorTag("HttpClientError", (e) =>
              Effect.logWarning("resend API error", { cause: e }),
            ),
            Effect.catchTags({
              HttpClientError: (e) =>
                Effect.fail(new SendError({ message: `Resend API error: ${e.message}`, cause: e })),
              SchemaError: (e) =>
                Effect.fail(
                  new SendError({
                    message: `Resend response decode failed: ${e.message}`,
                    cause: e,
                  }),
                ),
            }),
          ),
      });
    }),
  );
