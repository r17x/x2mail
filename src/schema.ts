/**
 * @module schema
 * @description Core data shapes for x2mail — envelope, inbox message, account config.
 */

import { Effect, Schema } from "effect";

export const Email = Schema.String.pipe(Schema.brand("Email"));
export type Email = typeof Email.Type;

export const Password = Schema.String.pipe(Schema.brand("Password"));
export type Password = typeof Password.Type;

export const MessageId = Schema.String.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;

export const MsgNum = Schema.Finite.pipe(Schema.brand("MsgNum"));
export type MsgNum = typeof MsgNum.Type;

export const Hostname = Schema.String.pipe(Schema.brand("Hostname"));
export type Hostname = typeof Hostname.Type;

export const Envelope = Schema.Struct({
  from: Email,
  to: Schema.Array(Email),
});
export type Envelope = typeof Envelope.Type;

export const InboxMessage = Schema.Struct({
  id: MessageId,
  raw: Schema.Uint8Array,
  receivedAt: Schema.DateTimeUtc,
});
export type InboxMessage = typeof InboxMessage.Type;

export const ResendSendConfig = Schema.Struct({
  provider: Schema.Literal("resend"),
  apiKey: Schema.String,
});

export const PostmarkSendConfig = Schema.Struct({
  provider: Schema.Literal("postmark"),
  serverToken: Schema.String,
});

export const MailgunSendConfig = Schema.Struct({
  provider: Schema.Literal("mailgun"),
  apiKey: Schema.String,
  domain: Schema.String,
});

export const SesSendConfig = Schema.Struct({
  provider: Schema.Literal("ses"),
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  region: Schema.String,
});

export const SmtpRelaySendConfig = Schema.Struct({
  provider: Schema.Literal("smtp"),
  host: Hostname,
  port: Schema.Finite,
  username: Schema.String,
  password: Password,
});

export const AccountSendConfig = Schema.Union([
  ResendSendConfig,
  PostmarkSendConfig,
  MailgunSendConfig,
  SesSendConfig,
  SmtpRelaySendConfig,
]);
export type AccountSendConfig = typeof AccountSendConfig.Type;

export const R2ReceiveConfig = Schema.Struct({
  provider: Schema.Literal("r2"),
  accountId: Schema.String,
  apiToken: Schema.String,
  bucket: Schema.String,
});

export const S3ReceiveConfig = Schema.Struct({
  provider: Schema.Literal("s3"),
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  region: Schema.String,
  bucket: Schema.String,
});

export const GmailReceiveConfig = Schema.Struct({
  provider: Schema.Literal("gmail"),
  clientId: Schema.String,
  clientSecret: Schema.String,
  refreshToken: Schema.String,
});

export const ImapReceiveConfig = Schema.Struct({
  provider: Schema.Literal("imap"),
  host: Hostname,
  port: Schema.Finite,
  username: Schema.String,
  password: Password,
  tls: Schema.Boolean,
});

export const AccountReceiveConfig = Schema.Union([
  R2ReceiveConfig,
  S3ReceiveConfig,
  GmailReceiveConfig,
  ImapReceiveConfig,
]);
export type AccountReceiveConfig = typeof AccountReceiveConfig.Type;

export const TlsConfig = Schema.Struct({
  certFile: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("cert.pem"))),
  keyFile: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("key.pem"))),
});

export const ServerConfig = Schema.Struct({
  hostname: Hostname.pipe(Schema.withDecodingDefault(Effect.succeed("localhost"))),
  smtpPort: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(587))),
  pop3Port: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(110))),
  pollInterval: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(30))),
  maxMessages: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(1000))),
  maxDataMb: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(25))),
});

export const Account = Schema.Struct({
  email: Email,
  password: Password,
  send: Schema.optional(AccountSendConfig),
  receive: Schema.optional(AccountReceiveConfig),
});
export type Account = typeof Account.Type;

export const XhConfig = Schema.Struct({
  accounts: Schema.Array(Account),
  server: ServerConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
