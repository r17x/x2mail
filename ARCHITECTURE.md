# x2mail Architecture

x2mail is a personal email bridge. Mail clients connect to x2mail through SMTP/POP3. x2mail connects to email providers through HTTP/TCP.

```
Mail Client ←TCP→ x2mail ←HTTP/TCP→ Email Provider
              │                      │
         SMTP (587)              Resend API
         POP3 (110)              Postmark API
                                 Mailgun API
                                 SES API
                                 SMTP relay
                                 R2 / S3
                                 Gmail API
                                 IMAP server
```

## File Map

```
src/
  main.ts              CLI entry, config loading, layer wiring
  config.ts            Config entry point, ServerConfig service, config loader
  schema.ts            Envelope, InboxMessage, Account, provider config unions
  error.ts             SendError, FetchError, ProtocolError, SessionDone
  account.ts           AccountStore service -- credential verification
  store.ts             MailStore service -- Ref-backed in-memory inbox

  smtp.ts              SMTP TCP server, per-connection state machine
  smtp.command.ts      SMTP line parser (tagged union) + response builders
  pop3.ts              POP3 TCP server, per-connection state machine
  pop3.command.ts      POP3 line parser (tagged union) + response builders

  send.ts              SendProvider contract + provider dispatch via Match
  send.resend.ts       Resend -- POST raw MIME as message/rfc822
  send.postmark.ts     Postmark -- POST base64 JSON
  send.mailgun.ts      Mailgun -- POST multipart FormData
  send.ses.ts          SES v2 -- POST JSON with SigV4
  send.smtp.ts         SMTP relay -- TCP forward with dot-stuffing

  receive.ts           ReceiveProvider contract + provider dispatch via Match
  receive.r2.ts        R2 -- CF API list + get
  receive.s3.ts        S3 -- ListObjectsV2 + GetObject with SigV4
  receive.gmail.ts     Gmail -- REST API with OAuth2 token refresh
  receive.imap.ts      IMAP -- LOGIN, SEARCH SINCE, FETCH BODY[]

  poller.ts            Background poll loop -- Schedule.spaced per account
  aws.sigv4.ts         AWS SigV4 signing via Web Crypto
```

## Send Path

```ts
SmtpServer.run()
  → handleSession(socket)
    → processLine(line, ref, write)
      case DataEnd:
        → SendProvider.send(raw, envelope)
          → makeSendLayer(account.send)
            case "resend"  → ResendSend.make   → HttpClient
            case "postmark"→ PostmarkSend.make  → HttpClient
            case "mailgun" → MailgunSend.make   → HttpClient
            case "ses"     → SesSend.make       → HttpClient + SigV4
            case "smtp"    → SmtpSend.make      → Socket (TCP/TLS)
```

## Receive Path

```ts
Poller.start(accounts)
  → pollOnce (per account, forkDetach on Schedule.spaced)
    → ReceiveProvider.fetch(since) / .remove(id)
      → makeReceiveLayer(account.receive)
        case "r2"   → R2Receive.make    → HttpClient
        case "s3"   → S3Receive.make    → HttpClient + SigV4
        case "gmail"→ GmailReceive.make → HttpClient + OAuth2
        case "imap" → ImapReceive.make  → Socket (TCP+TLS)
    → MailStore.addMessages(account, messages)

Pop3Server.run()
  → handleSession(socket)
    → processLine(line, state, write, stateRef)
      → MailStore.list / .get / .size / .totalSize / .markDelete / .commitDeletes / .resetDeletes
```

## State Machines

**SMTP:** `greeting → ehlo → auth → mail → rcpt → data → mail → ...`

```
greeting → ehlo → auth → mail ←──┐
                           ↓      │
                          rcpt    │
                           ↓      │
                          data ───┘
```

**POP3:** `auth_user → auth_pass → transaction → quit`

```
auth_user → auth_pass → transaction → quit
              │              ↑
              └──────────────┘  (auth fail)
```

## Module Map

```
Entry:           main.ts, config.ts
Servers:         smtp.ts, pop3.ts
Parsers:         smtp.command.ts, pop3.command.ts
Services:        account.ts, store.ts
Contracts:       send.ts, receive.ts, schema.ts, error.ts
Send providers:  send.resend.ts, send.postmark.ts, send.mailgun.ts, send.ses.ts, send.smtp.ts
Recv providers:  receive.r2.ts, receive.s3.ts, receive.gmail.ts, receive.imap.ts
Shared:          aws.sigv4.ts
Poller:          poller.ts
```

## R Channel

```
SmtpServer.run         R = ServerConfig | AccountStore | SendProvider (per message, via makeSendLayer)
Pop3Server.run         R = ServerConfig | AccountStore | MailStore
Poller.start           R = ServerConfig | MailStore | ReceiveProvider (per account, via makeReceiveLayer)
makeSendLayer(config)  R = HttpClient (HTTP providers) | never (TCP providers)
makeReceiveLayer(cfg)  R = HttpClient (HTTP providers) | never (TCP providers)
```

The system scopes `SendProvider` per-message and `ReceiveProvider` per-poll. It constructs them from the account config at call time. They are not part of the global layer.

## E Channel

The system uses three tagged errors and one control-flow error. Each error is scoped at its layer boundary.

```
SendError      ← send providers → SmtpServer (caught → 451 SMTP temp error)
FetchError     ← receive providers → Poller (caught → Effect.logWarning, poll continues)
ProtocolError  ← AccountStore, MailStore → SMTP/POP3 servers (auth fail → 535/ERR, bad index → ERR)
SessionDone    ← protocol servers → signals normal session end (QUIT / connection close)
```

Errors do not cross domain boundaries. The system converts `SendError` to an SMTP response code, `FetchError` to a log line, `ProtocolError` to a protocol-level rejection, and `SessionDone` to a clean session teardown.

## Shapes

```ts
Envelope         { from: Email, to: Email[] }
InboxMessage     { id: MessageId, raw: Uint8Array, receivedAt: DateTime.Utc }
Account          { email: Email, password: Password, send?: AccountSendConfig, receive?: AccountReceiveConfig }
ServerConfig     { hostname: Hostname, smtpPort: number, pop3Port: number, pollInterval: number, maxMessages: number, maxDataMb: number } (all with defaults)
XhConfig         { accounts: Account[], server: ServerConfig } (server defaults to {})
SmtpCommand      TaggedUnion: Ehlo | AuthPlain | MailFrom | RcptTo | Data | DataLine | DataEnd | ...
Pop3Command      TaggedUnion: User | Pass | Stat | List | Retr | Dele | Quit | ...
```

## Layer Wiring

```ts
program
  → parseConfig(path)
  → Effect.provide(appLayer)
      appLayer = AccountStore.make(accounts) + MailStore.layer
  → Effect.all([SmtpServer.run, Pop3Server.run, Poller.start], unbounded)
  → Effect.provide(FetchHttpClient.layer)
  → BunRuntime.runMain
```

The system provides `HttpClient` once at the outermost layer. It provides `AccountStore` and `MailStore` to the concurrent server group. It constructs the per-message `SendProvider` and per-poll `ReceiveProvider` inline from the account config. They are not in the global layer.
