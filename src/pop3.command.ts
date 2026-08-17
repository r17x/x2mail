/**
 * @module pop3.command
 * @description Pure POP3 command parser — line → Pop3Command tagged union, plus response builders.
 */

import { Match, Schema, String as Str } from "effect";
import { Email, MsgNum, Password } from "./schema.ts";

export const Pop3Command = Schema.TaggedUnion({
  User: { name: Email },
  Pass: { password: Password },
  Stat: {},
  List: { msgNum: Schema.optional(MsgNum) },
  Retr: { msgNum: MsgNum },
  Dele: { msgNum: MsgNum },
  Quit: {},
  Noop: {},
  Unknown: { raw: Schema.String },
});

export type Pop3Command = typeof Pop3Command.Type;

const parseNum = (s: string | undefined) => {
  if (s === undefined) return undefined;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
};

export const parseLine = (line: string) => {
  const upper = line.toUpperCase();
  return Match.value(upper).pipe(
    Match.when(Str.startsWith("USER "), () =>
      Pop3Command.cases.User.make({ name: line.slice(5).trim() as Email }),
    ),
    Match.when(Str.startsWith("PASS "), () =>
      Pop3Command.cases.Pass.make({ password: line.slice(5) as Password }),
    ),
    Match.when("STAT", () => Pop3Command.cases.Stat.make({})),
    Match.when(Str.startsWith("LIST"), () => {
      const arg = line.slice(4).trim();
      if (arg === "") return Pop3Command.cases.List.make({});
      const n = parseNum(arg);
      return n !== undefined
        ? Pop3Command.cases.List.make({ msgNum: n as MsgNum })
        : Pop3Command.cases.Unknown.make({ raw: line });
    }),
    Match.when(Str.startsWith("RETR "), () => {
      const n = parseNum(line.slice(5).trim());
      return n !== undefined
        ? Pop3Command.cases.Retr.make({ msgNum: n as MsgNum })
        : Pop3Command.cases.Unknown.make({ raw: line });
    }),
    Match.when(Str.startsWith("DELE "), () => {
      const n = parseNum(line.slice(5).trim());
      return n !== undefined
        ? Pop3Command.cases.Dele.make({ msgNum: n as MsgNum })
        : Pop3Command.cases.Unknown.make({ raw: line });
    }),
    Match.when("QUIT", () => Pop3Command.cases.Quit.make({})),
    Match.when("NOOP", () => Pop3Command.cases.Noop.make({})),
    Match.orElse(() => Pop3Command.cases.Unknown.make({ raw: line })),
  );
};

export const greeting = () => "+OK x2mail POP3 server ready\r\n";

export const okResponse = (msg?: string) => `+OK${msg ? " " + msg : ""}\r\n`;

export const errResponse = (msg?: string) => `-ERR${msg ? " " + msg : ""}\r\n`;

export const statResponse = (count: number, size: number) => `+OK ${count} ${size}\r\n`;

export const listResponse = (messages: ReadonlyArray<{ num: number; size: number }>) =>
  `+OK\r\n${messages.map((m) => `${m.num} ${m.size}\r\n`).join("")}.\r\n`;

const byteStuffLine = (line: string) => (line.startsWith(".") ? "." + line : line);

export const messageResponse = (raw: Uint8Array) =>
  "+OK\r\n" +
  new TextDecoder().decode(raw).split("\r\n").map(byteStuffLine).join("\r\n") +
  "\r\n.\r\n";
