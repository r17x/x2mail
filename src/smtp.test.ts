/**
 * @module smtp.test
 * @description Level 1 protocol tests for SMTP — parser, response builders, and session handler.
 */

import { Effect } from "effect";
import { describe, it, expect } from "bun:test";
import { AccountStore } from "./account.ts";
import type { Email, Hostname, Password } from "./schema.ts";
import * as SmtpCmd from "./smtp.command.ts";

describe("SMTP Command Parser", () => {
  describe("parseLine in command mode", () => {
    it("should parse EHLO with hostname", () => {
      expect(SmtpCmd.parseLine("EHLO mail.example.com", false)).toEqual({
        _tag: "Ehlo",
        host: "mail.example.com" as Hostname,
      });
    });

    it("should parse EHLO case-insensitively", () => {
      expect(SmtpCmd.parseLine("ehlo test.local", false)).toEqual({
        _tag: "Ehlo",
        host: "test.local" as Hostname,
      });
    });

    it("should preserve original case in EHLO hostname", () => {
      expect(SmtpCmd.parseLine("EHLO MyHost.Local", false)).toEqual({
        _tag: "Ehlo",
        host: "MyHost.Local" as Hostname,
      });
    });

    it("should parse AUTH PLAIN with base64 payload", () => {
      const encoded = btoa("\0user@test.com\0password123");
      expect(SmtpCmd.parseLine(`AUTH PLAIN ${encoded}`, false)).toEqual({
        _tag: "AuthPlain",
        encoded,
      });
    });

    it("should parse AUTH PLAIN case-insensitively", () => {
      const encoded = btoa("\0a@b.com\0pass");
      expect(SmtpCmd.parseLine(`auth plain ${encoded}`, false)).toEqual({
        _tag: "AuthPlain",
        encoded,
      });
    });

    it("should parse MAIL FROM with angle brackets", () => {
      expect(SmtpCmd.parseLine("MAIL FROM:<sender@example.com>", false)).toEqual({
        _tag: "MailFrom",
        address: "sender@example.com" as Email,
      });
    });

    it("should parse MAIL FROM with space after colon", () => {
      expect(SmtpCmd.parseLine("MAIL FROM: <sender@example.com>", false)).toEqual({
        _tag: "MailFrom",
        address: "sender@example.com" as Email,
      });
    });

    it("should parse MAIL FROM with space before colon", () => {
      expect(SmtpCmd.parseLine("MAIL FROM :<sender@example.com>", false)).toEqual({
        _tag: "MailFrom",
        address: "sender@example.com" as Email,
      });
    });

    it("should parse MAIL FROM without brackets", () => {
      expect(SmtpCmd.parseLine("MAIL FROM:sender@example.com", false)).toEqual({
        _tag: "MailFrom",
        address: "sender@example.com" as Email,
      });
    });

    it("should parse MAIL FROM case-insensitively", () => {
      expect(SmtpCmd.parseLine("mail from:<x@y.com>", false)).toEqual({
        _tag: "MailFrom",
        address: "x@y.com" as Email,
      });
    });

    it("should parse RCPT TO with angle brackets", () => {
      expect(SmtpCmd.parseLine("RCPT TO:<recipient@example.com>", false)).toEqual({
        _tag: "RcptTo",
        address: "recipient@example.com" as Email,
      });
    });

    it("should parse RCPT TO with space after colon", () => {
      expect(SmtpCmd.parseLine("RCPT TO: <recipient@example.com>", false)).toEqual({
        _tag: "RcptTo",
        address: "recipient@example.com" as Email,
      });
    });

    it("should parse RCPT TO with space before colon", () => {
      expect(SmtpCmd.parseLine("RCPT TO :<recipient@example.com>", false)).toEqual({
        _tag: "RcptTo",
        address: "recipient@example.com" as Email,
      });
    });

    it("should parse RCPT TO case-insensitively", () => {
      expect(SmtpCmd.parseLine("rcpt to:<a@b.com>", false)).toEqual({
        _tag: "RcptTo",
        address: "a@b.com" as Email,
      });
    });

    it("should parse DATA command", () => {
      expect(SmtpCmd.parseLine("DATA", false)).toEqual({ _tag: "Data" });
    });

    it("should parse DATA case-insensitively", () => {
      expect(SmtpCmd.parseLine("data", false)).toEqual({ _tag: "Data" });
    });

    it("should parse QUIT command", () => {
      expect(SmtpCmd.parseLine("QUIT", false)).toEqual({ _tag: "Quit" });
    });

    it("should parse QUIT case-insensitively", () => {
      expect(SmtpCmd.parseLine("quit", false)).toEqual({ _tag: "Quit" });
    });

    it("should parse RSET command", () => {
      expect(SmtpCmd.parseLine("RSET", false)).toEqual({ _tag: "Rset" });
    });

    it("should parse RSET case-insensitively", () => {
      expect(SmtpCmd.parseLine("rset", false)).toEqual({ _tag: "Rset" });
    });

    it("should parse NOOP command", () => {
      expect(SmtpCmd.parseLine("NOOP", false)).toEqual({ _tag: "Noop" });
    });

    it("should parse NOOP case-insensitively", () => {
      expect(SmtpCmd.parseLine("noop", false)).toEqual({ _tag: "Noop" });
    });

    it("should return Unknown for unrecognized input", () => {
      expect(SmtpCmd.parseLine("VRFY user@example.com", false)).toEqual({
        _tag: "Unknown",
        raw: "VRFY user@example.com",
      });
    });

    it("should return Unknown for empty input", () => {
      expect(SmtpCmd.parseLine("", false)).toEqual({
        _tag: "Unknown",
        raw: "",
      });
    });
  });

  describe("parseLine in data mode", () => {
    it("should return DataEnd for lone dot", () => {
      expect(SmtpCmd.parseLine(".", true)).toEqual({ _tag: "DataEnd" });
    });

    it("should return DataLine for regular text", () => {
      expect(SmtpCmd.parseLine("Subject: Hello", true)).toEqual({
        _tag: "DataLine",
        line: "Subject: Hello",
      });
    });

    it("should return DataLine for empty string", () => {
      expect(SmtpCmd.parseLine("", true)).toEqual({
        _tag: "DataLine",
        line: "",
      });
    });

    it("should return DataLine for dot-prefixed text (not lone dot)", () => {
      expect(SmtpCmd.parseLine("..leading dot", true)).toEqual({
        _tag: "DataLine",
        line: "..leading dot",
      });
    });

    it("should return DataLine for SMTP commands in data mode", () => {
      expect(SmtpCmd.parseLine("QUIT", true)).toEqual({
        _tag: "DataLine",
        line: "QUIT",
      });
    });
  });

  describe("AUTH PLAIN base64 decoding", () => {
    it("should decode standard AUTH PLAIN format (NUL authzid NUL authcid NUL password)", () => {
      const encoded = btoa("\0user@example.com\0mypassword");
      const parsed = SmtpCmd.parseLine(`AUTH PLAIN ${encoded}`, false);
      expect(parsed._tag).toBe("AuthPlain");
      if (parsed._tag === "AuthPlain") {
        const decoded = atob(parsed.encoded);
        const parts = decoded.split("\0");
        expect(parts[1]).toBe("user@example.com");
        expect(parts[2]).toBe("mypassword");
      }
    });

    it("should handle AUTH PLAIN with authzid prefix", () => {
      const encoded = btoa("admin\0user@example.com\0secret");
      const parsed = SmtpCmd.parseLine(`AUTH PLAIN ${encoded}`, false);
      expect(parsed._tag).toBe("AuthPlain");
      if (parsed._tag === "AuthPlain") {
        const decoded = atob(parsed.encoded);
        const parts = decoded.split("\0");
        expect(parts[0]).toBe("admin");
        expect(parts[1]).toBe("user@example.com");
        expect(parts[2]).toBe("secret");
      }
    });
  });
});

describe("SMTP Response Builders", () => {
  it("should produce greeting with hostname", () => {
    expect(SmtpCmd.greeting("mail.example.com" as Hostname)).toBe(
      "220 mail.example.com ESMTP x2mail\r\n",
    );
  });

  it("should produce EHLO response with AUTH capability", () => {
    const response = SmtpCmd.ehloResponse("mail.example.com" as Hostname);
    expect(response).toBe("250-mail.example.com\r\n250-AUTH PLAIN\r\n250 OK\r\n");
  });

  it("should produce OK response with default message", () => {
    expect(SmtpCmd.ok()).toBe("250 OK\r\n");
  });

  it("should produce OK response with custom message", () => {
    expect(SmtpCmd.ok("Message accepted")).toBe("250 Message accepted\r\n");
  });

  it("should produce DATA start response", () => {
    expect(SmtpCmd.startData()).toBe("354 Start mail input; end with <CRLF>.<CRLF>\r\n");
  });

  it("should produce AUTH success response", () => {
    expect(SmtpCmd.authOk()).toBe("235 2.7.0 Authentication successful\r\n");
  });

  it("should produce AUTH failure response", () => {
    expect(SmtpCmd.authFail()).toBe("535 5.7.8 Authentication failed\r\n");
  });

  it("should produce BYE response", () => {
    expect(SmtpCmd.bye()).toBe("221 Bye\r\n");
  });

  it("should produce error response with code", () => {
    expect(SmtpCmd.error(503, "Bad sequence of commands")).toBe("503 Bad sequence of commands\r\n");
  });

  it("should produce temp error response", () => {
    expect(SmtpCmd.tempError("try again later")).toBe("451 try again later\r\n");
  });

  it("should produce perm error response", () => {
    expect(SmtpCmd.permError("mailbox not found")).toBe("550 mailbox not found\r\n");
  });

  it("should terminate all responses with CRLF", () => {
    expect(SmtpCmd.greeting("host" as Hostname)).toMatch(/\r\n$/);
    expect(SmtpCmd.ehloResponse("host" as Hostname)).toMatch(/\r\n$/);
    expect(SmtpCmd.ok()).toMatch(/\r\n$/);
    expect(SmtpCmd.startData()).toMatch(/\r\n$/);
    expect(SmtpCmd.authOk()).toMatch(/\r\n$/);
    expect(SmtpCmd.authFail()).toMatch(/\r\n$/);
    expect(SmtpCmd.bye()).toMatch(/\r\n$/);
    expect(SmtpCmd.error(500, "err")).toMatch(/\r\n$/);
    expect(SmtpCmd.tempError("err")).toMatch(/\r\n$/);
    expect(SmtpCmd.permError("err")).toMatch(/\r\n$/);
  });
});

describe("SMTP Session (AccountStore + SendProvider)", () => {
  it("should authenticate valid credentials via AccountStore", () =>
    Effect.gen(function* () {
      const store = yield* AccountStore;
      const result = yield* store.authenticate("test@example.com" as Email, "secret" as Password);
      expect(result.email).toBe("test@example.com" as Email);
      expect(result.send?.provider).toBe("resend");
      expect(result.send?.provider === "resend" && result.send.apiKey).toBe("test-key");
    }).pipe(
      Effect.provide(
        AccountStore.layerTest({
          accounts: [
            {
              email: "test@example.com" as Email,
              password: "secret" as Password,
              send: { provider: "resend" as const, apiKey: "test-key" },
            },
          ],
        }),
      ),
      Effect.runPromise,
    ));

  it("should reject invalid credentials via AccountStore", () =>
    Effect.gen(function* () {
      const store = yield* AccountStore;
      return yield* store.authenticate("test@example.com" as Email, "wrong" as Password);
    }).pipe(
      Effect.provide(
        AccountStore.layerTest({
          accounts: [
            {
              email: "test@example.com" as Email,
              password: "secret" as Password,
              send: { provider: "resend" as const, apiKey: "test-key" },
            },
          ],
        }),
      ),
      Effect.catchTag("ProtocolError", (e) =>
        Effect.succeed({ rejected: true, message: e.message }),
      ),
      Effect.map((result) => {
        expect(result).toEqual({ rejected: true, message: "Authentication failed" });
      }),
      Effect.runPromise,
    ));

  it("should reject when email does not match", () =>
    Effect.gen(function* () {
      const store = yield* AccountStore;
      return yield* store.authenticate("unknown@example.com" as Email, "secret" as Password);
    }).pipe(
      Effect.provide(
        AccountStore.layerTest({
          accounts: [
            {
              email: "test@example.com" as Email,
              password: "secret" as Password,
            },
          ],
        }),
      ),
      Effect.catchTag("ProtocolError", (_e) => Effect.succeed({ rejected: true })),
      Effect.map((result) => {
        expect(result).toEqual({ rejected: true });
      }),
      Effect.runPromise,
    ));
});
