/**
 * @module send
 * @description SendProvider service contract — provider-agnostic email sending.
 */

import { Context, Match } from "effect";
import type { Effect } from "effect";
import type { Envelope, AccountSendConfig } from "./schema.ts";
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
    ) => Effect.Effect<void, SendError>;
  }
>()("@x2mail/SendProvider") {
  static layer = (config: AccountSendConfig) =>
    Match.value(config).pipe(
      Match.when({ provider: "resend" }, ResendSend.make),
      Match.when({ provider: "postmark" }, PostmarkSend.make),
      Match.when({ provider: "mailgun" }, MailgunSend.make),
      Match.when({ provider: "ses" }, SesSend.make),
      Match.when({ provider: "smtp" }, SmtpSend.make),
      Match.exhaustive,
    );
}
