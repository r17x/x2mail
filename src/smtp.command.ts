/**
 * @module smtp.command
 * @description Pure SMTP command parser — line → SmtpCommand tagged union, plus response builders.
 */

import { Match, Schema, String as Str } from "effect";
import { Email, Hostname } from "./schema.ts";

export const SmtpCommand = Schema.TaggedUnion({
  Ehlo: { host: Hostname },
  AuthPlain: { encoded: Schema.String },
  MailFrom: { address: Email },
  RcptTo: { address: Email },
  Data: {},
  DataLine: { line: Schema.String },
  DataEnd: {},
  Quit: {},
  Rset: {},
  Noop: {},
  Unknown: { raw: Schema.String },
});

export type SmtpCommand = typeof SmtpCommand.Type;

const extractBracketAddress = (s: string) => {
  const start = s.indexOf("<");
  const end = s.indexOf(">");
  return start !== -1 && end !== -1 ? s.slice(start + 1, end) : s.trim();
};

const parseCommandLine = (line: string) => {
  const upper = line.toUpperCase();
  return Match.value(upper).pipe(
    Match.when(Str.startsWith("EHLO "), () =>
      SmtpCommand.cases.Ehlo.make({ host: line.slice(5).trim() as Hostname }),
    ),
    Match.when(Str.startsWith("AUTH PLAIN "), () =>
      SmtpCommand.cases.AuthPlain.make({ encoded: line.slice(11).trim() }),
    ),
    Match.when(Str.startsWith("MAIL FROM"), () =>
      SmtpCommand.cases.MailFrom.make({
        address: extractBracketAddress(line.slice(line.indexOf(":") + 1)) as Email,
      }),
    ),
    Match.when(Str.startsWith("RCPT TO"), () =>
      SmtpCommand.cases.RcptTo.make({
        address: extractBracketAddress(line.slice(line.indexOf(":") + 1)) as Email,
      }),
    ),
    Match.when("DATA", () => SmtpCommand.cases.Data.make({})),
    Match.when("QUIT", () => SmtpCommand.cases.Quit.make({})),
    Match.when("RSET", () => SmtpCommand.cases.Rset.make({})),
    Match.when("NOOP", () => SmtpCommand.cases.Noop.make({})),
    Match.orElse(() => SmtpCommand.cases.Unknown.make({ raw: line })),
  );
};

export const parseLine = (line: string, inDataMode: boolean) =>
  inDataMode
    ? line === "."
      ? SmtpCommand.cases.DataEnd.make({})
      : SmtpCommand.cases.DataLine.make({ line })
    : parseCommandLine(line);

export const greeting = (hostname: Hostname) => `220 ${hostname} ESMTP x2mail\r\n`;

export const ehloResponse = (hostname: Hostname) =>
  `250-${hostname}\r\n250-AUTH PLAIN\r\n250 OK\r\n`;

export const ok = (message?: string) => `250 ${message ?? "OK"}\r\n`;

export const startData = () => `354 Start mail input; end with <CRLF>.<CRLF>\r\n`;

export const authOk = () => `235 2.7.0 Authentication successful\r\n`;

export const authFail = () => `535 5.7.8 Authentication failed\r\n`;

export const bye = () => `221 Bye\r\n`;

export const error = (code: number, message: string) => `${code} ${message}\r\n`;

export const tempError = (message: string) => `451 ${message}\r\n`;

export const permError = (message: string) => `550 ${message}\r\n`;
