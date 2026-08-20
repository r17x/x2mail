/**
 * @module receive
 * @description ReceiveProvider service contract — provider-agnostic email fetching.
 */

import { Context, type Effect, Match, type DateTime } from "effect";
import type { FetchError } from "./error.ts";
import type { InboxMessage, AccountReceiveConfig, MessageId } from "./schema.ts";
import * as GmailReceive from "./receive.gmail.ts";
import * as ImapReceive from "./receive.imap.ts";
import * as R2Receive from "./receive.r2.ts";
import * as S3Receive from "./receive.s3.ts";

export class ReceiveProvider extends Context.Service<
  ReceiveProvider,
  {
    readonly fetch: (since: DateTime.Utc) => Effect.Effect<ReadonlyArray<InboxMessage>, FetchError>;
    readonly remove: (id: MessageId) => Effect.Effect<void, FetchError>;
  }
>()("@x2mail/ReceiveProvider") {
  static layer = (config: AccountReceiveConfig) =>
    Match.value(config).pipe(
      Match.when({ provider: "r2" }, R2Receive.make),
      Match.when({ provider: "s3" }, S3Receive.make),
      Match.when({ provider: "gmail" }, GmailReceive.make),
      Match.when({ provider: "imap" }, ImapReceive.make),
      Match.exhaustive,
    );
}
