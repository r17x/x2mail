/**
 * @module config.test
 * Proves the Config trust boundary — valid decode, invalid rejection, server defaults, ConfigProvider sharing.
 */

import { Config, ConfigProvider, Effect, Schema } from "effect";
import { describe, expect, it } from "bun:test";
import type { Email, Hostname, Password } from "./schema.ts";
import { XhConfig } from "./schema.ts";

describe("Config trust boundary", () => {
  it("should decode valid XhConfig from Effect default export", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeEffect(XhConfig)({
        accounts: [{ email: "a@b.com", password: "secret" }],
      });
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0]?.email).toBe("a@b.com" as Email);
      expect(result.accounts[0]?.password).toBe("secret" as Password);
    }).pipe(Effect.runPromise));

  it("should apply server defaults when server key is absent", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeEffect(XhConfig)({
        accounts: [],
      });
      expect(result.server.hostname).toBe("localhost" as Hostname);
      expect(result.server.smtpPort).toBe(587);
      expect(result.server.pop3Port).toBe(110);
      expect(result.server.pollInterval).toBe(30);
      expect(result.server.maxMessages).toBe(1000);
      expect(result.server.maxDataMb).toBe(25);
    }).pipe(Effect.runPromise));

  it("should allow partial server overrides", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeEffect(XhConfig)({
        accounts: [],
        server: { hostname: "mail.example.com", smtpPort: 2525 },
      });
      expect(result.server.hostname).toBe("mail.example.com" as Hostname);
      expect(result.server.smtpPort).toBe(2525);
      expect(result.server.pop3Port).toBe(110);
    }).pipe(Effect.runPromise));

  it("should reject invalid data at trust boundary", () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknownEffect(XhConfig)({
        accounts: [{ invalid: true }],
      }).pipe(Effect.flip);
      expect(error).toBeDefined();
    }).pipe(Effect.runPromise));

  it("should share caller's fiber tree for Config access", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const key = yield* Config.string("TEST_KEY");
        return { accounts: [{ email: `${key}@test.com`, password: "p" }] };
      });
      const raw = yield* program;
      const result = yield* Schema.decodeEffect(XhConfig)(raw);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0]?.email).toBe("test_value@test.com" as Email);
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ TEST_KEY: "test_value" }))),
      Effect.runPromise,
    ));
});
