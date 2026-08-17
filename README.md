## xh2m

> X: Something in HTTP to Mail

xh2m is a localhost TCP server. It translates between desktop mail protocols and HTTP email APIs.

Desktop mail clients use SMTP and POP3 over TCP. Modern email services use HTTP with bearer tokens and JSON. These two protocols share no wire format. xh2m bridges them: your mail client connects to `localhost:587` to send and `localhost:110` to receive. xh2m then connects to your email API -- Resend, Postmark, Mailgun, SES, a real SMTP relay, R2, S3, Gmail, or IMAP.

xh2m uses one JSON config file. It supports multiple accounts. It runs as a single process with no daemon framework.

## Quick Start

```
bunx xh2m
```

This minimal `config.json` shows one account that uses Resend for sending and R2 for receiving:

```json
{
  "accounts": [
    {
      "email": "you@example.com",
      "password": "mailbox-password",
      "send": {
        "provider": "resend",
        "apiKey": "re_xxxxx"
      },
      "receive": {
        "provider": "r2",
        "accountId": "cf-account-id",
        "apiToken": "cf-api-token",
        "bucket": "inbound-mail"
      }
    }
  ]
}
```

Point your mail client at `localhost`:

- **SMTP** -- `localhost:587`, AUTH PLAIN, your email + password from config
- **POP3** -- `localhost:110`, USER/PASS, same credentials

## Config

The full config schema:

```json
{
  "smtpPort": 587,
  "pop3Port": 110,
  "pollInterval": 30,
  "accounts": []
}
```

`smtpPort`, `pop3Port`, and `pollInterval` (seconds) all have defaults. Only the `accounts` field is required.

The system applies three layers of override. The highest priority wins:

| Priority    | Source      | Example                                                         |
| ----------- | ----------- | --------------------------------------------------------------- |
| 1 (highest) | CLI flags   | `--smtp-port 2525 --pop3-port 1110 --poll-interval 60`          |
| 2           | ENV vars    | `XH2M_SMTP_PORT=2525 XH2M_POP3_PORT=1110 XH2M_POLL_INTERVAL=60` |
| 3 (lowest)  | Config file | `"smtpPort": 2525`                                              |

```
bun run src/main.ts config.json --smtp-port 2525 --poll-interval 60
```

## Providers

### Send

| Provider   | `provider`   | Auth                    | What it does                               |
| ---------- | ------------ | ----------------------- | ------------------------------------------ |
| Resend     | `"resend"`   | Bearer token            | POST raw MIME as `message/rfc822`          |
| Postmark   | `"postmark"` | X-Postmark-Server-Token | POST base64-encoded raw MIME as JSON       |
| Mailgun    | `"mailgun"`  | Basic `api:{key}`       | POST multipart FormData to `messages.mime` |
| SES        | `"ses"`      | AWS SigV4               | POST JSON to SES v2 `outbound-emails`      |
| SMTP relay | `"smtp"`     | AUTH PLAIN over TCP     | Forward raw MIME with dot-stuffing         |

### Receive

| Provider | `provider` | Auth                  | What it does                          |
| -------- | ---------- | --------------------- | ------------------------------------- |
| R2       | `"r2"`     | Bearer (CF API token) | List + Get objects from Cloudflare R2 |
| S3       | `"s3"`     | AWS SigV4             | ListObjectsV2 + GetObject from S3     |
| Gmail    | `"gmail"`  | OAuth2 refresh token  | Gmail REST API, base64url decode      |
| IMAP     | `"imap"`   | LOGIN over TCP/TLS    | SEARCH SINCE + FETCH BODY[]           |

### Provider Configs

**Cloudflare user** -- uses Resend + R2:

```json
{
  "email": "you@example.com",
  "password": "mailbox-password",
  "send": {
    "provider": "resend",
    "apiKey": "re_xxxxx"
  },
  "receive": {
    "provider": "r2",
    "accountId": "cf-account-id",
    "apiToken": "cf-api-token",
    "bucket": "inbound-mail"
  }
}
```

**AWS user** -- uses SES + S3:

```json
{
  "email": "you@example.com",
  "password": "mailbox-password",
  "send": {
    "provider": "ses",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "region": "us-east-1"
  },
  "receive": {
    "provider": "s3",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "region": "us-east-1",
    "bucket": "inbound-mail"
  }
}
```

**Gmail user** -- uses SMTP relay (via Gmail SMTP) + Gmail API:

```json
{
  "email": "you@gmail.com",
  "password": "mailbox-password",
  "send": {
    "provider": "smtp",
    "host": "smtp.gmail.com",
    "port": 465,
    "username": "you@gmail.com",
    "password": "app-password"
  },
  "receive": {
    "provider": "gmail",
    "clientId": "xxxx.apps.googleusercontent.com",
    "clientSecret": "...",
    "refreshToken": "..."
  }
}
```

**Self-hosted** -- uses SMTP relay + IMAP:

```json
{
  "email": "you@mail.example.com",
  "password": "mailbox-password",
  "send": {
    "provider": "smtp",
    "host": "mail.example.com",
    "port": 465,
    "username": "you@mail.example.com",
    "password": "smtp-password"
  },
  "receive": {
    "provider": "imap",
    "host": "mail.example.com",
    "port": 993,
    "username": "you@mail.example.com",
    "password": "imap-password",
    "tls": true
  }
}
```

**Transactional** -- uses Postmark send + IMAP receive, or Mailgun send + S3 receive:

```json
{
  "send": {
    "provider": "postmark",
    "serverToken": "xxxx-xxxx-xxxx"
  },
  "receive": {
    "provider": "imap",
    "host": "mail.example.com",
    "port": 993,
    "username": "replies@example.com",
    "password": "...",
    "tls": true
  }
}
```

```json
{
  "send": {
    "provider": "mailgun",
    "apiKey": "key-xxxxx",
    "domain": "mg.example.com"
  },
  "receive": {
    "provider": "s3",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "region": "us-east-1",
    "bucket": "inbound-mail"
  }
}
```

## How It Works

The system starts three concurrent loops with `Effect.all` at unbounded concurrency:

1. **SMTP server** -- Listens on `smtpPort` and accepts TCP connections. It runs a per-connection state machine: `EHLO -> AUTH PLAIN -> MAIL FROM -> RCPT TO -> DATA -> [send via provider] -> 250 OK`. It passes the raw MIME bytes from DATA directly to the send provider. The SMTP relay path applies dot-stuffing.

2. **POP3 server** -- Listens on `pop3Port` and accepts TCP connections. It runs a per-connection state machine: `USER -> PASS -> STAT/LIST/RETR/DELE -> QUIT`. Messages come from an in-memory `MailStore` (Ref-backed HashMap). The server stages deletes per-session and commits them on QUIT.

3. **Poller** -- Starts one detached fiber per account that has a receive config. Each fiber runs on `Schedule.spaced(pollInterval)`, calls the receive provider's `fetch(since)`, and writes new messages into the MailStore. The `since` cursor tracks the last successful poll time.

```
Mail client                    xh2m                         Email service
    |                           |                               |
    |--- SMTP (localhost) ----->|--- HTTP POST / TCP relay ---->|
    |                           |                               |
    |<-- POP3 (localhost) ------|<-- HTTP GET / IMAP FETCH -----|
    |                           |     (poller, every Ns)        |
```

## Multi-Account

Each account entry in the config array has its own email, password, send config, and receive config. Send and receive are both optional. You can have send-only or receive-only accounts.

Mail clients authenticate with the account's email and password. The SMTP server looks up the matching account on AUTH PLAIN. The POP3 server looks it up on USER/PASS. The poller spawns one independent fiber per account that has a receive config.

## Errors

Three error types:

- **SendError** -- provider HTTP call failed, SMTP relay rejected, no send config
- **FetchError** -- provider HTTP call failed, IMAP session failed, token refresh failed
- **ProtocolError** -- authentication failed, bad command sequence, message not found

Errors are tagged values in the Effect E channel. They propagate through the call graph without silent swallowing. The send providers retry transient HTTP errors (5xx, network) with exponential backoff (`Schedule.exponential("200 millis")`, 3 retries) through `HttpClient.retryTransient`.

Non-transient errors appear as SMTP `451` temporary failure responses or POP3 `-ERR` responses. The poller logs warnings and continues to poll.
