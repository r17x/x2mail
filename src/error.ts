/**
 * @module error
 * @description Domain errors for x2mail — send, fetch, and protocol failures.
 */

import { Schema } from "effect";

export class SendError extends Schema.TaggedError<SendError>()("SendError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FetchError extends Schema.TaggedError<FetchError>()("FetchError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  message: Schema.String,
}) {}

/** Control-flow error — signals that a protocol session has ended normally. */
export class SessionDone extends Schema.TaggedError<SessionDone>()("SessionDone", {}) {}
