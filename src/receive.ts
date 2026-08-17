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
>()("xh2m/ReceiveProvider") {}

export const makeReceiveLayer = (config: AccountReceiveConfig) =>
  Match.value(config).pipe(
    Match.when({ provider: "r2" }, (c) =>
      R2Receive.make({ accountId: c.accountId, apiToken: c.apiToken, bucket: c.bucket }),
    ),
    Match.when({ provider: "s3" }, (c) =>
      S3Receive.make({
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        region: c.region,
        bucket: c.bucket,
      }),
    ),
    Match.when({ provider: "gmail" }, (c) =>
      GmailReceive.make({
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        refreshToken: c.refreshToken,
      }),
    ),
    Match.when({ provider: "imap" }, (c) =>
      ImapReceive.make({
        host: c.host,
        port: c.port,
        username: c.username,
        password: c.password,
        tls: c.tls,
      }),
    ),
    Match.exhaustive,
  );
