/**
 * @module account
 * @description Account store — credential verification and provider config resolution.
 */

import { Array as Arr, Context, Effect, Layer, pipe } from "effect";
import { ProtocolError } from "./error.ts";
import type { Account, Email, Password } from "./schema.ts";

export class AccountStore extends Context.Service<
  AccountStore,
  {
    readonly authenticate: (
      email: Email,
      password: Password,
    ) => Effect.Effect<Account, ProtocolError>;
  }
>()("xh2m/AccountStore") {}

export const make = (accounts: ReadonlyArray<Account>) =>
  Layer.succeed(
    AccountStore,
    AccountStore.of({
      authenticate: Effect.fn("AccountStore.authenticate")(function* (
        email: Email,
        password: Password,
      ) {
        return yield* pipe(
          Arr.findFirst(accounts, (a) => a.email === email && a.password === password),
          Effect.fromOption(() => new ProtocolError({ message: "Authentication failed" })),
        );
      }),
    }),
  );
