# x2mail Architecture

x2mail is a personal email bridge. Mail clients connect to x2mail through SMTP/POP3. x2mail connects to email providers through HTTP/TCP.

```
Mail Client <-TCP-> x2mail <-HTTP/TCP-> Email Provider
              |                      |
         SMTP (587)              Resend API
         POP3 (110)              Postmark API
                                 Mailgun API
                                 SES API
                                 SMTP relay
                                 R2 / S3
                                 Gmail API
                                 IMAP server
```

## 1. Shapes

The domain language: what flows through the graph.

| Kind     | Name                | Fields / Members |
|----------|---------------------|------------------|
| Record   | `Account`           | `email, password, send?, receive?` |
| Record   | `InboxMessage`      | `id: MessageId, raw: Uint8Array, receivedAt: DateTime.Utc` |
| Record   | `Envelope`          | `from: Email, to: Email[]` |
| ID       | `Email`             | Branded string |
| ID       | `Password`          | Branded string |
| ID       | `Hostname`          | Branded string |
| ID       | `MessageId`         | Branded string |
| ID       | `MsgNum`            | Branded number |
| Variant  | `SmtpCommand`       | `Ehlo \| AuthPlain \| MailFrom \| RcptTo \| Data \| DataLine \| DataEnd \| Rset \| Noop \| Quit \| Unknown` |
| Variant  | `Pop3Command`       | `User \| Pass \| Stat \| List \| Retr \| Dele \| Noop \| Quit \| Unknown` |
| Variant  | `SmtpPhase`         | `greeting \| ehlo \| auth \| mail \| rcpt \| data \| quit` |
| Variant  | `Pop3Phase`         | `auth_user \| auth_pass \| transaction \| quit` |
| Error    | `SendError`         | Tagged error from send providers |
| Error    | `FetchError`        | Tagged error from receive providers |
| Error    | `ProtocolError`     | Tagged error from AccountStore and MailStore |
| Error    | `SessionDone`       | Control-flow signal for clean session teardown |
| Config   | `AppConfig`         | `{ accounts: Account[], server: ServerConfig }` |

## 2. A (the happy path)

Three concurrent paths run inside `Effect.all(unbounded)`.

**Send** -- mail client submits a message through SMTP, x2mail dispatches it to a provider:

```ts
SMTP Server
  -> Auth
       -> AccountStore
  -> Collect Message
  -> SendProvider
       -> Match dispatch:
            resend | postmark | mailgun | ses | smtp
       -> Email Service (HTTP or TCP)
```

**Receive** -- the poller fetches new mail from a provider and stores it:

```ts
Poller
  -> ReceiveProvider
       -> Match dispatch:
            r2 | s3 | gmail | imap
       -> Provider Service (HTTP or TCP)
  -> MailStore.addMessages
```

**Retrieve** -- mail client retrieves stored messages through POP3:

```ts
POP3 Server
  -> Auth
       -> AccountStore
  -> MailStore
       -> list / get / size / markDelete / commitDeletes
```

## 4. E (where the graph breaks)

Each error stays within its domain boundary. The system converts errors to protocol responses or log lines at the boundary.

| Error           | Source                    | Caught at      | Becomes                       |
|-----------------|---------------------------|----------------|-------------------------------|
| `SendError`     | Send providers            | SMTP Server    | 451 temporary SMTP error      |
| `FetchError`    | Receive providers         | Poller         | Log warning, poll continues   |
| `ProtocolError` | AccountStore, MailStore   | SMTP/POP3      | Protocol rejection (535/ERR)  |
| `SessionDone`   | Protocol servers          | Session handler| Clean session teardown        |

Errors do not cross domain boundaries.

## 5. R (what each node needs)

| Service           | Contract                      | R                |
|-------------------|-------------------------------|------------------|
| `AppConfig`       | `{ accounts, server }`        | `never`          |
| `AccountStore`    | `authenticate(email, pw)`     | `AppConfig`      |
| `MailStore`       | `list / get / add / delete`   | `AppConfig`      |
| `SendProvider`    | `send(raw, envelope)`         | Per-message, constructed from account config |
| `ReceiveProvider` | `fetch(since) / remove(id)`   | Per-account, constructed from account config |

`SendProvider` and `ReceiveProvider` are NOT in the global layer. The system constructs them per-message and per-poll from the account config.

### Layer wiring

```ts
cli
  -> parseConfig
       -> Schema.decodeUnknownEffect(XhConfig)
  -> Layer.succeed(AppConfig)
  -> AccountStore.layer          R = AppConfig
  -> MailStore.layer             R = AppConfig
  -> Effect.all([SMTP, POP3, Poller], unbounded)
  -> FetchHttpClient.layer
  -> BunRuntime.runMain
```

The system provides `HttpClient` once at the outermost layer. `AccountStore` and `MailStore` feed the concurrent server group. Per-message `SendProvider` and per-poll `ReceiveProvider` are constructed inline from the account config.

## 6. Boundary

The trust boundary is `parseConfig`. It performs dynamic import, then Schema decode into `AppConfig`. After that point, the types are trusted.

Each send and receive provider decodes HTTP responses at its own boundary. Provider-level Schema decode converts unknown API responses into trusted domain records.

## 9. Test (R-swap proof)

```ts
AppConfig.layerTest(overrides?)      -> Schema defaults + overrides
AccountStore.layerTest(overrides?)   -> AccountStore.layer + AppConfig.layerTest
MailStore.layerTest(overrides?)      -> MailStore.layer + AppConfig.layerTest
```

Same graph shape. Same A. Same E. Different R.

Provider tests swap `HttpClient` R with mock fetch. TCP provider tests use a mock `net.Server`.

## State Machines

**SMTP:** `greeting -> ehlo -> auth -> mail -> rcpt -> data -> mail -> ...`

```
greeting -> ehlo -> auth -> mail <---+
                             |       |
                            rcpt     |
                             |       |
                            data ----+
```

**POP3:** `auth_user -> auth_pass -> transaction -> quit`

```
auth_user -> auth_pass -> transaction -> quit
                |              ^
                +--------------+  (auth fail)
```
