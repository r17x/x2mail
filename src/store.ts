/**
 * @module store
 * @description In-memory mail store — Ref-backed per-account inbox for POP3 serving.
 */

import { Array as Arr, Context, Effect, HashMap, Layer, Option, pipe, Ref } from "effect";
import { AppConfig } from "./config";
import { ProtocolError } from "./error";
import type { Email, InboxMessage, MsgNum } from "./schema";

type StoredMessage = {
  readonly message: InboxMessage;
  readonly deleted: boolean;
};

const getActive = (map: HashMap.HashMap<Email, ReadonlyArray<StoredMessage>>, account: Email) =>
  pipe(
    HashMap.get(map, account),
    Option.getOrElse(() => [] as ReadonlyArray<StoredMessage>),
    Arr.filter((m) => !m.deleted),
  );

const getAll = (map: HashMap.HashMap<Email, ReadonlyArray<StoredMessage>>, account: Email) =>
  pipe(
    HashMap.get(map, account),
    Option.getOrElse(() => [] as ReadonlyArray<StoredMessage>),
  );

const activeAt = (active: ReadonlyArray<StoredMessage>, index: MsgNum) =>
  pipe(
    Arr.get(active, index - 1),
    Effect.fromOption(() => new ProtocolError({ message: `no such message ${index}` })),
  );

export class MailStore extends Context.Service<
  MailStore,
  {
    readonly list: (account: Email) => Effect.Effect<ReadonlyArray<InboxMessage>>;
    readonly get: (account: Email, index: MsgNum) => Effect.Effect<InboxMessage, ProtocolError>;
    readonly size: (account: Email, index: MsgNum) => Effect.Effect<number, ProtocolError>;
    readonly totalSize: (account: Email) => Effect.Effect<number>;
    readonly addMessages: (
      account: Email,
      messages: ReadonlyArray<InboxMessage>,
    ) => Effect.Effect<void>;
    readonly markDelete: (account: Email, index: MsgNum) => Effect.Effect<void, ProtocolError>;
    readonly commitDeletes: (account: Email) => Effect.Effect<void>;
    readonly resetDeletes: (account: Email) => Effect.Effect<void>;
  }
>()("@x2mail/MailStore") {
  static layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { server } = yield* AppConfig;
      const ref = yield* Ref.make(HashMap.empty<Email, ReadonlyArray<StoredMessage>>());

      return MailStore.of({
        list: Effect.fn("MailStore.list")(function* (account: Email) {
          const map = yield* Ref.get(ref);
          return Arr.map(getActive(map, account), (m) => m.message);
        }),

        get: Effect.fn("MailStore.get")(function* (account: Email, index: MsgNum) {
          const map = yield* Ref.get(ref);
          const stored = yield* activeAt(getActive(map, account), index);
          return stored.message;
        }),

        size: Effect.fn("MailStore.size")(function* (account: Email, index: MsgNum) {
          const map = yield* Ref.get(ref);
          const stored = yield* activeAt(getActive(map, account), index);
          return stored.message.raw.byteLength;
        }),

        totalSize: Effect.fn("MailStore.totalSize")(function* (account: Email) {
          const map = yield* Ref.get(ref);
          return Arr.reduce(getActive(map, account), 0, (sum, m) => sum + m.message.raw.byteLength);
        }),

        addMessages: Effect.fn("MailStore.addMessages")(function* (
          account: Email,
          messages: ReadonlyArray<InboxMessage>,
        ) {
          yield* Ref.update(ref, (map) =>
            HashMap.set(
              map,
              account,
              pipe(
                HashMap.get(map, account),
                Option.getOrElse(() => [] as ReadonlyArray<StoredMessage>),
                (existing) =>
                  Arr.takeRight(
                    [...existing, ...Arr.map(messages, (message) => ({ message, deleted: false }))],
                    server.maxMessages,
                  ),
              ),
            ),
          );
        }),

        markDelete: Effect.fn("MailStore.markDelete")(function* (account: Email, index: MsgNum) {
          const result = yield* Ref.modify(ref, (map) => {
            const all = getAll(map, account);
            const active = Arr.filter(all, (m) => !m.deleted);
            return pipe(
              Arr.get(active, index - 1),
              Option.match({
                onNone: () => [Option.none<void>(), map] as const,
                onSome: (target) =>
                  [
                    Option.some(undefined as void),
                    HashMap.set(
                      map,
                      account,
                      Arr.map(all, (m) => (m === target ? { ...m, deleted: true } : m)),
                    ),
                  ] as const,
              }),
            );
          });
          yield* Effect.fromOption(
            result,
            () => new ProtocolError({ message: `no such message ${index}` }),
          );
        }),

        commitDeletes: Effect.fn("MailStore.commitDeletes")(function* (account: Email) {
          yield* Ref.update(ref, (map) =>
            HashMap.set(
              map,
              account,
              Arr.filter(getAll(map, account), (m) => !m.deleted),
            ),
          );
        }),

        resetDeletes: Effect.fn("MailStore.resetDeletes")(function* (account: Email) {
          yield* Ref.update(ref, (map) =>
            HashMap.set(
              map,
              account,
              Arr.map(getAll(map, account), (m) => (m.deleted ? { ...m, deleted: false } : m)),
            ),
          );
        }),
      });
    }),
  );

  static layerTest = (impl?: Parameters<typeof AppConfig.layerTest>[0]) =>
    MailStore.layer.pipe(Layer.provide(AppConfig.layerTest(impl)));
}
