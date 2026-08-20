/**
 * @module pop3.test
 * @description Level 1 protocol tests for POP3 — parser, response builders, and MailStore.
 */

import { DateTime, Effect } from "effect";
import { describe, it, expect } from "bun:test";
import * as Pop3Cmd from "./pop3.command.ts";
import type { Email, MessageId, MsgNum, Password } from "./schema.ts";
import { MailStore } from "./store.ts";

describe("POP3 Command Parser", () => {
  describe("parseLine", () => {
    it("should parse USER with username", () => {
      expect(Pop3Cmd.parseLine("USER alice@example.com")).toEqual({
        _tag: "User",
        name: "alice@example.com" as Email,
      });
    });

    it("should parse USER case-insensitively", () => {
      expect(Pop3Cmd.parseLine("user bob@test.com")).toEqual({
        _tag: "User",
        name: "bob@test.com" as Email,
      });
    });

    it("should trim USER name", () => {
      expect(Pop3Cmd.parseLine("USER  alice@example.com  ")).toEqual({
        _tag: "User",
        name: "alice@example.com" as Email,
      });
    });

    it("should parse PASS with password", () => {
      expect(Pop3Cmd.parseLine("PASS secretpassword")).toEqual({
        _tag: "Pass",
        password: "secretpassword" as Password,
      });
    });

    it("should parse PASS case-insensitively", () => {
      expect(Pop3Cmd.parseLine("pass mypass")).toEqual({
        _tag: "Pass",
        password: "mypass" as Password,
      });
    });

    it("should preserve spaces in PASS password", () => {
      expect(Pop3Cmd.parseLine("PASS my secret password")).toEqual({
        _tag: "Pass",
        password: "my secret password" as Password,
      });
    });

    it("should preserve leading space in PASS password", () => {
      expect(Pop3Cmd.parseLine("PASS  leading")).toEqual({
        _tag: "Pass",
        password: " leading" as Password,
      });
    });

    it("should parse STAT command", () => {
      expect(Pop3Cmd.parseLine("STAT")).toEqual({ _tag: "Stat" });
    });

    it("should parse STAT case-insensitively", () => {
      expect(Pop3Cmd.parseLine("stat")).toEqual({ _tag: "Stat" });
    });

    it("should parse LIST without argument", () => {
      expect(Pop3Cmd.parseLine("LIST")).toEqual({
        _tag: "List",
        msgNum: undefined,
      });
    });

    it("should parse LIST with message number", () => {
      expect(Pop3Cmd.parseLine("LIST 3")).toEqual({
        _tag: "List",
        msgNum: 3 as MsgNum,
      });
    });

    it("should parse LIST case-insensitively", () => {
      expect(Pop3Cmd.parseLine("list 1")).toEqual({
        _tag: "List",
        msgNum: 1 as MsgNum,
      });
    });

    it("should return Unknown for LIST with non-numeric arg", () => {
      expect(Pop3Cmd.parseLine("LIST abc")).toEqual({
        _tag: "Unknown",
        raw: "LIST abc",
      });
    });

    it("should parse RETR with message number", () => {
      expect(Pop3Cmd.parseLine("RETR 1")).toEqual({
        _tag: "Retr",
        msgNum: 1 as MsgNum,
      });
    });

    it("should parse RETR case-insensitively", () => {
      expect(Pop3Cmd.parseLine("retr 2")).toEqual({
        _tag: "Retr",
        msgNum: 2 as MsgNum,
      });
    });

    it("should return Unknown for RETR with non-numeric arg", () => {
      expect(Pop3Cmd.parseLine("RETR xyz")).toEqual({
        _tag: "Unknown",
        raw: "RETR xyz",
      });
    });

    it("should return Unknown for RETR without argument", () => {
      expect(Pop3Cmd.parseLine("RETR ")).toEqual({
        _tag: "Unknown",
        raw: "RETR ",
      });
    });

    it("should parse DELE with message number", () => {
      expect(Pop3Cmd.parseLine("DELE 5")).toEqual({
        _tag: "Dele",
        msgNum: 5 as MsgNum,
      });
    });

    it("should parse DELE case-insensitively", () => {
      expect(Pop3Cmd.parseLine("dele 3")).toEqual({
        _tag: "Dele",
        msgNum: 3 as MsgNum,
      });
    });

    it("should return Unknown for DELE with non-numeric arg", () => {
      expect(Pop3Cmd.parseLine("DELE foo")).toEqual({
        _tag: "Unknown",
        raw: "DELE foo",
      });
    });

    it("should parse QUIT command", () => {
      expect(Pop3Cmd.parseLine("QUIT")).toEqual({ _tag: "Quit" });
    });

    it("should parse QUIT case-insensitively", () => {
      expect(Pop3Cmd.parseLine("quit")).toEqual({ _tag: "Quit" });
    });

    it("should parse NOOP command", () => {
      expect(Pop3Cmd.parseLine("NOOP")).toEqual({ _tag: "Noop" });
    });

    it("should parse NOOP case-insensitively", () => {
      expect(Pop3Cmd.parseLine("noop")).toEqual({ _tag: "Noop" });
    });

    it("should return Unknown for unrecognized command", () => {
      expect(Pop3Cmd.parseLine("UIDL 1")).toEqual({
        _tag: "Unknown",
        raw: "UIDL 1",
      });
    });

    it("should return Unknown for empty string", () => {
      expect(Pop3Cmd.parseLine("")).toEqual({
        _tag: "Unknown",
        raw: "",
      });
    });
  });
});

describe("POP3 Response Builders", () => {
  it("should produce greeting", () => {
    expect(Pop3Cmd.greeting()).toBe("+OK x2mail POP3 server ready\r\n");
  });

  it("should produce OK response without message", () => {
    expect(Pop3Cmd.okResponse()).toBe("+OK\r\n");
  });

  it("should produce OK response with message", () => {
    expect(Pop3Cmd.okResponse("logged in")).toBe("+OK logged in\r\n");
  });

  it("should produce ERR response without message", () => {
    expect(Pop3Cmd.errResponse()).toBe("-ERR\r\n");
  });

  it("should produce ERR response with message", () => {
    expect(Pop3Cmd.errResponse("authentication failed")).toBe("-ERR authentication failed\r\n");
  });

  it("should produce STAT response with count and size", () => {
    expect(Pop3Cmd.statResponse(3, 12345)).toBe("+OK 3 12345\r\n");
  });

  it("should produce STAT response for empty mailbox", () => {
    expect(Pop3Cmd.statResponse(0, 0)).toBe("+OK 0 0\r\n");
  });

  it("should produce LIST response for multiple messages", () => {
    const response = Pop3Cmd.listResponse([
      { num: 1, size: 100 },
      { num: 2, size: 200 },
      { num: 3, size: 300 },
    ]);
    expect(response).toBe("+OK\r\n1 100\r\n2 200\r\n3 300\r\n.\r\n");
  });

  it("should produce LIST response for empty mailbox", () => {
    expect(Pop3Cmd.listResponse([])).toBe("+OK\r\n.\r\n");
  });

  it("should produce message response with dot-stuffing", () => {
    const raw = new TextEncoder().encode("Subject: Test\r\n\r\n.starts with dot\r\nnormal line");
    const response = Pop3Cmd.messageResponse(raw);
    expect(response).toBe("+OK\r\nSubject: Test\r\n\r\n..starts with dot\r\nnormal line\r\n.\r\n");
  });

  it("should produce message response for simple body", () => {
    const raw = new TextEncoder().encode("Subject: Hello\r\n\r\nHello World");
    const response = Pop3Cmd.messageResponse(raw);
    expect(response).toBe("+OK\r\nSubject: Hello\r\n\r\nHello World\r\n.\r\n");
  });

  it("should terminate all responses with CRLF", () => {
    expect(Pop3Cmd.greeting()).toMatch(/\r\n$/);
    expect(Pop3Cmd.okResponse()).toMatch(/\r\n$/);
    expect(Pop3Cmd.okResponse("msg")).toMatch(/\r\n$/);
    expect(Pop3Cmd.errResponse()).toMatch(/\r\n$/);
    expect(Pop3Cmd.errResponse("msg")).toMatch(/\r\n$/);
    expect(Pop3Cmd.statResponse(1, 100)).toMatch(/\r\n$/);
  });
});

describe("MailStore", () => {
  const makeTestMessage = (id: string, content: string) => ({
    id: id as MessageId,
    raw: new TextEncoder().encode(content),
    receivedAt: DateTime.makeUnsafe("2024-01-01T00:00:00Z"),
  });

  it("should list messages for an account", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [
        makeTestMessage("msg-1", "Hello"),
        makeTestMessage("msg-2", "World"),
      ]);
      const result = yield* store.list("user@test.com" as Email);
      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe("msg-1" as MessageId);
      expect(result[1]?.id).toBe("msg-2" as MessageId);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise));

  it("should return empty list for unknown account", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      const result = yield* store.list("nobody@test.com" as Email);
      expect(result).toHaveLength(0);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise));

  it("should get message by 1-based index", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [
        makeTestMessage("msg-1", "First"),
        makeTestMessage("msg-2", "Second"),
      ]);
      const result = yield* store.get("user@test.com" as Email, 2 as MsgNum);
      expect(result.id).toBe("msg-2" as MessageId);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise));

  it("should fail on get with out-of-range index", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [makeTestMessage("msg-1", "Hello")]);
      return yield* store.get("user@test.com" as Email, 5 as MsgNum);
    }).pipe(
      Effect.provide(MailStore.layerTest()),
      Effect.catchTag("ProtocolError", (e) => Effect.succeed({ failed: true, message: e.message })),
      Effect.map((result) => {
        expect(result).toEqual({ failed: true, message: "no such message 5" });
      }),
      Effect.runPromise,
    ));

  it("should return message size by index", () => {
    const content = "Hello World";
    return Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [makeTestMessage("msg-1", content)]);
      const result = yield* store.size("user@test.com" as Email, 1 as MsgNum);
      expect(result).toBe(new TextEncoder().encode(content).byteLength);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise);
  });

  it("should compute totalSize across all messages", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [
        makeTestMessage("msg-1", "abc"),
        makeTestMessage("msg-2", "defgh"),
      ]);
      const result = yield* store.totalSize("user@test.com" as Email);
      expect(result).toBe(8);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise));

  it("should mark message as deleted and exclude from list", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [
        makeTestMessage("msg-1", "First"),
        makeTestMessage("msg-2", "Second"),
        makeTestMessage("msg-3", "Third"),
      ]);
      yield* store.markDelete("user@test.com" as Email, 2 as MsgNum);
      const result = yield* store.list("user@test.com" as Email);
      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe("msg-1" as MessageId);
      expect(result[1]?.id).toBe("msg-3" as MessageId);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise));

  it("should fail on markDelete with out-of-range index", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [makeTestMessage("msg-1", "Hello")]);
      return yield* store.markDelete("user@test.com" as Email, 99 as MsgNum);
    }).pipe(
      Effect.provide(MailStore.layerTest()),
      Effect.catchTag("ProtocolError", (e) => Effect.succeed({ failed: true, message: e.message })),
      Effect.map((result) => {
        expect(result).toEqual({ failed: true, message: "no such message 99" });
      }),
      Effect.runPromise,
    ));

  it("should commitDeletes to permanently remove marked messages", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [
        makeTestMessage("msg-1", "First"),
        makeTestMessage("msg-2", "Second"),
      ]);
      yield* store.markDelete("user@test.com" as Email, 1 as MsgNum);
      yield* store.commitDeletes("user@test.com" as Email);
      yield* store.resetDeletes("user@test.com" as Email);
      const result = yield* store.list("user@test.com" as Email);
      // After commit + reset, deleted messages stay gone
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("msg-2" as MessageId);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise));

  it("should resetDeletes to restore marked messages before commit", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [
        makeTestMessage("msg-1", "First"),
        makeTestMessage("msg-2", "Second"),
      ]);
      yield* store.markDelete("user@test.com" as Email, 1 as MsgNum);
      yield* store.resetDeletes("user@test.com" as Email);
      const result = yield* store.list("user@test.com" as Email);
      // After reset without commit, all messages are restored
      expect(result).toHaveLength(2);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise));

  it("should isolate messages between accounts", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("alice@test.com" as Email, [
        makeTestMessage("msg-a", "Alice's mail"),
      ]);
      yield* store.addMessages("bob@test.com" as Email, [
        makeTestMessage("msg-b1", "Bob mail 1"),
        makeTestMessage("msg-b2", "Bob mail 2"),
      ]);
      const alice = yield* store.list("alice@test.com" as Email);
      const bob = yield* store.list("bob@test.com" as Email);
      expect(alice).toHaveLength(1);
      expect(bob).toHaveLength(2);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise));

  it("should reindex after delete so get uses active indices", () =>
    Effect.gen(function* () {
      const store = yield* MailStore;
      yield* store.addMessages("user@test.com" as Email, [
        makeTestMessage("msg-1", "First"),
        makeTestMessage("msg-2", "Second"),
        makeTestMessage("msg-3", "Third"),
      ]);
      yield* store.markDelete("user@test.com" as Email, 1 as MsgNum);
      // After deleting index 1, active messages are msg-2 and msg-3
      // Index 1 should now be msg-2, index 2 should be msg-3
      const first = yield* store.get("user@test.com" as Email, 1 as MsgNum);
      const second = yield* store.get("user@test.com" as Email, 2 as MsgNum);
      expect(first.id).toBe("msg-2" as MessageId);
      expect(second.id).toBe("msg-3" as MessageId);
    }).pipe(Effect.provide(MailStore.layerTest()), Effect.runPromise));
});
