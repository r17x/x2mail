/**
 * @module aws.sigv4
 * @description AWS Signature Version 4 request signing via Web Crypto.
 */

import { Array as Arr, DateTime, Effect } from "effect";

const sha256Hex = (data: globalThis.Uint8Array) =>
  Effect.map(
    Effect.promise(() => crypto.subtle.digest("SHA-256", data)),
    (hash) =>
      Arr.map(Array.from(new globalThis.Uint8Array(hash)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
  );

const hmacSign = (key: globalThis.Uint8Array, data: globalThis.Uint8Array) =>
  Effect.promise(() =>
    crypto.subtle
      .importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .then((cryptoKey) => crypto.subtle.sign("HMAC", cryptoKey, data)),
  ).pipe(Effect.map((buf) => new globalThis.Uint8Array(buf)));

const hmacHex = (key: globalThis.Uint8Array, data: globalThis.Uint8Array) =>
  Effect.map(hmacSign(key, data), (bytes) =>
    Arr.map(Array.from(bytes), (b) => b.toString(16).padStart(2, "0")).join(""),
  );

const deriveSigningKey = (secretKey: string, dateStamp: string, region: string, service: string) =>
  hmacSign(new TextEncoder().encode("AWS4" + secretKey), new TextEncoder().encode(dateStamp)).pipe(
    Effect.flatMap((k) => hmacSign(k, new TextEncoder().encode(region))),
    Effect.flatMap((k) => hmacSign(k, new TextEncoder().encode(service))),
    Effect.flatMap((k) => hmacSign(k, new TextEncoder().encode("aws4_request"))),
  );

export const signRequest = (params: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: globalThis.Uint8Array | string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region: string;
  service: string;
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const amzDate = DateTime.formatIso(now).replace(/[-:]/g, "").replace(/\.\d+/, "");
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;

    const bodyBytes =
      typeof params.body === "string" ? new TextEncoder().encode(params.body) : params.body;
    const payloadHash = yield* sha256Hex(bodyBytes);

    const headersWithDate: Record<string, string> = {
      ...params.headers,
      host: params.url.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    };

    const sortedHeaderKeys = Object.keys(headersWithDate).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((k) => {
        const v = headersWithDate[k];
        if (v === undefined) throw new Error(`unreachable: key ${k} from Object.keys`);
        return `${k.toLowerCase()}:${v.trim()}\n`;
      })
      .join("");
    const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(";");

    const canonicalQueryString = [...params.url.searchParams]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const canonicalRequest = [
      params.method,
      params.url.pathname,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const canonicalRequestHash = yield* sha256Hex(new TextEncoder().encode(canonicalRequest));
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${canonicalRequestHash}`;

    const signingKey = yield* deriveSigningKey(
      params.credentials.secretAccessKey,
      dateStamp,
      params.region,
      params.service,
    );
    const signature = yield* hmacHex(signingKey, new TextEncoder().encode(stringToSign));

    return {
      ...headersWithDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${params.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  });
