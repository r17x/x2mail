/**
 * @module poller
 * @description Background poll loop — periodically fetches emails from ReceiveProvider into MailStore.
 */

import { Array as Arr, DateTime, Duration, Effect, Ref, Schedule } from "effect";
import type { Account } from "./schema.ts";
import { ServerConfig } from "./config.ts";
import { MailStore } from "./store.ts";
import { makeReceiveLayer, ReceiveProvider } from "./receive.ts";

export const start = (accounts: ReadonlyArray<Account>) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const mailStore = yield* MailStore;

    yield* Effect.forEach(
      Arr.filter(
        accounts,
        (a): a is Account & { receive: NonNullable<Account["receive"]> } => a.receive !== undefined,
      ),
      (account) =>
        Effect.gen(function* () {
          const receiveConfig = account.receive;
          const lastPoll = yield* Ref.make(DateTime.makeUnsafe(0));

          const pollOnce = Effect.gen(function* () {
            const since = yield* Ref.get(lastPoll);
            const provider = yield* ReceiveProvider;
            const messages = yield* provider.fetch(since);
            yield* mailStore.addMessages(account.email, messages);
            yield* Ref.set(lastPoll, yield* DateTime.now);
          }).pipe(
            Effect.provide(makeReceiveLayer(receiveConfig)),
            Effect.tapErrorTag("FetchError", (e) => Effect.logWarning("poll fetch failed", { cause: e })),
            Effect.catchTag("FetchError", () => Effect.void),
          );

          yield* pollOnce.pipe(
            Effect.repeat(Schedule.spaced(Duration.seconds(config.pollInterval))),
            Effect.forkDetach,
          );
        }),
      { discard: true },
    );
  });
