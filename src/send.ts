/**
 * @module send
 * @description SendProvider service contract — provider-agnostic email sending.
 */

import { Context, Match } from "effect";
import type { Effect } from "effect";
import type { Envelope, AccountSendConfig, MessageId } from "./schema.ts";
import type { SendError } from "./error.ts";
import * as MailgunSend from "./send.mailgun.ts";
import * as PostmarkSend from "./send.postmark.ts";
import * as ResendSend from "./send.resend.ts";
import * as SesSend from "./send.ses.ts";
import * as SmtpSend from "./send.smtp.ts";

export class SendProvider extends Context.Service<
  SendProvider,
  {
    readonly send: (
      raw: Uint8Array,
      envelope: Envelope,
    ) => Effect.Effect<{ readonly messageId: MessageId }, SendError>;
  }
>()("@x2mail/SendProvider") {}

export const makeSendLayer = (config: AccountSendConfig) =>
  Match.value(config).pipe(
    Match.when({ provider: "resend" }, (c) => ResendSend.make(c.apiKey)),
    Match.when({ provider: "postmark" }, (c) => PostmarkSend.make(c.serverToken)),
    Match.when({ provider: "mailgun" }, (c) =>
      MailgunSend.make({ apiKey: c.apiKey, domain: c.domain }),
    ),
    Match.when({ provider: "ses" }, (c) =>
      SesSend.make({
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        region: c.region,
      }),
    ),
    Match.when({ provider: "smtp" }, (c) => SmtpSend.make(c)),
    Match.exhaustive,
  );
