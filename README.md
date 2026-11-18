# Chores

A household chores app for the iPads: mark a task done (alone or with helpers), someone else approves it, points go towards real-world rewards. The design is in [docs/design-spec.md](docs/design-spec.md).

- **Front end:** React + Vite + Fluent UI (v9), installable as a PWA that opens and queues actions offline.
- **Back end:** Node + Fastify, with selectable SQLite (default) or DynamoDB storage. Both persist the event log, current projections, accounts, sessions and login throttles.
- **Live updates:** server-sent events. Changes made through another server instance are detected while browsers are connected.

## Quick start (development)

```sh
npm install
npm run dev          # on this computer: API on :3000, app with hot reload on http://localhost:5173
npm run dev:device   # on a phone or iPad: the built app on http://<this computer>:3000, rebuilt on save
npm test             # server rules: approvals, points, eligibility, retries, rollover, login
```

**Testing on a phone or iPad? Prefer `npm run dev:device` over the :5173 address.** The Vite dev server sends development builds of React and Fluent, unminified and in dozens of separate files: about 50 MB of JavaScript memory before you tap anything. On a phone over a VPN that's a slow first load, and iOS Safari may throw the tab away and reload it. `dev:device` serves the real build: 6 files, about 5 MB of memory, and a first screen in about 1 s even on a throttled connection. It has no live-reload connection, so after saving a change, wait a couple of seconds for the rebuild, then refresh.

Import icons from `client/src/icons.js`, never straight from `@fluentui/react-icons`. That package's main entry holds all ~28,000 icons, and in dev Vite loads every one of them (18 MB), which made dev loads on a phone take over 30 s.

The first visit asks you to create the first grown-up account. Add everyone else from **People**; each person then sets their own PIN under **Profile**.

## Running it on the NUC

```sh
npm ci
npm run build                       # builds client/dist, which the server serves
TLS_CERT=/etc/chores/cert.pem TLS_KEY=/etc/chores/key.pem npm start   # https on :3443
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 (3443 with TLS) | Listening port |
| `HOST` | `0.0.0.0` | Interface to bind |
| `STORAGE_BACKEND` | `sqlite` | `sqlite` or `dynamodb`; selected once at startup |
| `DB_PATH` | `./data/chores.db` | SQLite file; used only by the SQLite backend |
| `TLS_CERT`, `TLS_KEY` | unset | PEM files; turns on HTTPS and `Secure` cookies |
| `COOKIE_SECURE` | `true` with local TLS, otherwise `false` | Set `true` when HAProxy terminates public HTTPS |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy, so PIN throttling sees real client addresses |
| `TZ` | system | The household time zone. Lists roll over at midnight in this zone |

### Selecting storage

Selection uses environment variables only. The same application, API, rules and PWA work with either backend. Existing SQLite files receive additive schema upgrades on startup; accounts, sessions and history are preserved. Selecting DynamoDB opens a separate household store: it does **not** copy or synchronize your SQLite data. There is no automatic fallback when the selected backend is unavailable.

```sh
# Run with the existing SQLite backend (also the default when STORAGE_BACKEND is unset).
STORAGE_BACKEND=sqlite DB_PATH=./data/chores.db npm start
```

For DynamoDB, set these variables in your shell or service environment:

```sh
# Select an AWS region, a dedicated table and a stable household namespace.
export STORAGE_BACKEND=dynamodb
export AWS_REGION=ap-southeast-2
export DYNAMODB_TABLE=chores
export DYNAMODB_NAMESPACE=household

# Explicitly create an on-demand table if missing, validate its keys and enable session TTL.
npm run storage:setup

# Run the same application against that table; normal startup never creates a table.
npm start
```

| Variable | Default | Meaning |
|---|---|---|
| `DYNAMODB_TABLE` | required | Existing table with string partition key `pk` and string sort key `sk` |
| `AWS_REGION` | required; `AWS_DEFAULT_REGION` accepted | Region containing the table |
| `DYNAMODB_NAMESPACE` | `household` | Household partition; keep identical across instances serving the same family |
| `DYNAMODB_ENDPOINT` | AWS service endpoint | Optional HTTP/HTTPS override for DynamoDB Local |

Credentials come from the [standard AWS SDK provider chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html), including an IAM role or your configured AWS profile. The runtime needs `dynamodb:DescribeTable`, `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:PutItem` and `dynamodb:DeleteItem` on the selected table. Run provisioning separately with permission for `dynamodb:CreateTable`, `dynamodb:DescribeTimeToLive` and `dynamodb:UpdateTimeToLive` as well. Credentials are never stored in application code.

The adapter uses strongly consistent keyed reads and atomic conditional transactions. Projections are split into records per entity, rather than storing the whole household in one item. Each change is limited to 100 transaction operations, including metadata and audit writes, and a 4 MB transaction payload. A conservative 380 KiB serialized-record ceiling leaves room below DynamoDB's 400 KB item limit. Oversized changes are refused atomically. Action outcomes are retained for offline retry detection; only expired sessions have TTL cleanup, and authentication checks expiry without waiting for TTL deletion. See [DynamoDB constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html).

While SSE clients are connected, each server checks for remote revisions every two seconds; those checks consume DynamoDB reads. The PWA closes its live connection while hidden and reconnects when visible. Queued actions survive temporary HTTP 429 and server failures, with bounded retry delays.

For HAProxy terminating HTTPS for `tasks.fortheherd.net`, pass `COOKIE_SECURE=true` and `TRUST_PROXY=true`, and restrict direct access to the app so proxy headers come from HAProxy. Storage choice does not change the browser's HTTPS requirement or offline queue.

Use [.env.example](.env.example) as a configuration reference. The application reads its process environment; it does not automatically load an `.env` file.

### Testing both backends

```sh
# Run the application and storage regression tests using disposable SQLite databases.
npm test

# Run the same suite against isolated DynamoDB Local; requires a running Docker daemon.
# Uses a pinned official image, temporary credentials and a loopback-only random port.
# The container is removed afterwards; this command does not contact an AWS table.
npm run test:dynamodb
```

The tests cover cross-instance approvals, durable action retries, lost commit responses, shared throttling, account and PIN uniqueness, session revocation, live streams, paginated reads, size limits, existing SQLite compatibility, deployment boundaries and client retry rules.

### AWS deployment behind HAProxy

The [AWS deployment runbook](deploy/aws/README.md) packages the PWA, API and `/watch` for Lambda Web Functions in Oregon with DynamoDB in the same region. It includes CloudFormation templates, a protected first-parent setup command, and an HAProxy excerpt. AWS CloudShell uses your browser's signed-in identity, so a local AWS CLI installation is optional.

```sh
# Build a secret-free CloudShell upload bundle and test its application ZIP locally.
npm run package:aws
npm run test:aws-package
```

This creates a separate empty household; SQLite data is not migrated. The cloud deployment keeps `TZ=Australia/Melbourne` so the household's day boundaries stay local. The complete runbook covers uploading the bundle, creating the stacks and first parent, then connecting DNS, TLS and HAProxy.

### HTTPS is needed for the iPads

iPadOS only runs service workers (offline mode, home-screen install that keeps working) on HTTPS, or on `localhost`. Over plain `http://nuc.local` the app works online but won't open offline. Two simple ways to get a certificate the iPads trust:

- **mkcert:** `mkcert -install && mkcert nuc.local 192.168.1.20`, then install the generated root CA on each iPad (AirDrop the `rootCA.pem`, install the profile, then enable it under *Settings → General → About → Certificate Trust Settings*).
- **Caddy** in front of the app with `tls internal`. Same idea; trust Caddy's root CA on the iPads and set `TRUST_PROXY=true`.

Then on each iPad, open the site in Safari, tap **Share → Add to Home Screen**.

The direct NUC setup is intended for the home network or VPN. For the public hostname, use the [AWS deployment workflow](deploy/aws/README.md) with its proxy boundary and protected initial account setup.

### systemd (example)

```ini
# /etc/systemd/system/chores.service
[Unit]
Description=Chores app
After=network.target

[Service]
WorkingDirectory=/opt/chores
ExecStart=/usr/bin/node server/index.js
Environment=TLS_CERT=/etc/chores/cert.pem TLS_KEY=/etc/chores/key.pem TZ=Australia/Sydney
Restart=on-failure
User=chores

[Install]
WantedBy=multi-user.target
```

**Locked out?** On the NUC, from the project folder:

```sh
npm run reset-password dusty               # prompts twice; the password isn't shown
npm run reset-password dusty -- --sign-out # also signs that person out on every iPad
```

Run it with no username to list everyone. It uses the same storage environment as the server, works with either backend while the server is up, and records the reset in the event log. `--sign-out` revokes sessions across all server instances. If you can still sign in (say, with your PIN), a grown-up can also set a new password under People → Edit.

**Backups:** with SQLite, everything is in `DB_PATH`; use `sqlite3 data/chores.db ".backup backup.db"` (safe while running). For DynamoDB, configure table backups or point-in-time recovery separately; the provisioning utility does not enable backups.

### Apple Watch

A cut-down page at **`/watch`** lets you mark your own tasks done (on your own) and approve other people's. It's just a PIN box, then two buttons (My Tasks, Approve) that each open a list. Opening the main address on a screen narrower than 260 px also lands here, which is how to try it in browser developer tools (e.g. 198 × 242). The watch has no Safari app or address bar, so send the link once in Messages (to yourself, or to a kid's watch), pin that conversation, and tap the link to open it. Sign in with your PIN.

- It's plain HTML from the server with no JavaScript. Each tap is a form submit, so it only works while the watch can reach the NUC, and there's no offline mode.
- Each button carries an action id made when the page was drawn, so a double tap or a resubmitted form never counts twice.
- Helpers, sending back, rewards and editing stay on the iPad.
- **Not yet tried on a real watch.** Two things to check: whether the watch trusts the NUC's HTTPS certificate (installing the root CA on the paired iPhone may or may not be enough), and whether the watch keeps you signed in between visits. If it doesn't, you'll enter your PIN each time.

## Navigation

The home screen is just **My Tasks** and **Approve**, plus a small progress bar. Everything else is behind your avatar in the top corner: Rewards and Profile for everyone, Manage tasks, People and Settings for grown-ups, and Switch person. The points star also opens Rewards. Sign-in shows only the PIN keypad, with "Use username and password" underneath.

## How it works

- **Event log and projections.** Every task edit, completion, approval, send-back, points award and reward spend is persisted as an audit event alongside updated projections in the same transaction. SQLite triggers prevent changing or deleting events; DynamoDB inserts events conditionally under unique sequence keys. Startup loads current projections, without replaying the full history. An older SQLite file is replayed once to initialize its projection records. The displayed ledger retains the latest 60 entries per person; the event log retains the complete history. Account changes are audited, but credential hashes never appear in events.
- **Occurrences.** A task's schedule produces occurrences with stable ids: `taskId/periodStart` for a household job, or `taskId/periodStart/userId` for an "everyone does their own" task. Yesterday's dishwasher and today's are separate, and a pending approval never expires at midnight.
- **Offline and retries.** Each iPad keeps the last state and its own queue of actions in IndexedDB. Every action has a UUID made on the iPad, and the server records it in `actions`. A resend after reconnecting returns the original outcome and never applies twice, so no double points. A task marked done at 23:50 and sent at 00:10 still counts for its own day, because the iPad's timestamp is used (sanity-checked: no more than 5 minutes ahead or 14 days behind).
- **Concurrency.** A household revision serializes atomic commits across independent server processes. Conflicting decisions are retried against fresh state, so competing approvals cannot award points twice or overwrite another balance update. Sessions and login throttles use the same revision checks. Each process caches projections only while its storage revision matches.
- **Snapshot of terms.** A completion stores the points, allocation and multiple-approvals settings it was done under, so editing a task later doesn't change what people already earned.

## Decisions built in

Agreed on 15 Nov 2026 (also recorded in the spec):

| Topic | Behaviour |
|---|---|
| Quick-create defaults | Collaboration off, one approval, full points each |
| Extra endorsements | Contributors get completion points once (first approval). Every approver gets approval points |
| Uneven splits | Round up for everyone: 10 between 3 is 4 each |
| Shared vs personal | Per-task type. Today's progress = your own activities + shared jobs you helped with |

Choices made while building, which are easy to change:

- **Approval points** are a household setting (Settings), defaulting to **1**. The spec didn't give a value.
- **New tasks default to "One job for the household"**. That choice is on the main form, beside the List picker.
- **The Grown-ups list** is offered only to grown-up accounts. Other lists are open to anyone old enough.
- **Personal tasks go to everyone eligible, grown-ups included.** If "Reading" shouldn't be on a grown-up's list, give it a minimum age or ask for a "who it's for" option.
- **Sent-back shared jobs** go back only to the people who did them, not to everyone's list.
- **Changing a PIN or password** needs your current password, so a kid on a parent's unlocked iPad can't take over that account.
- **"PIN already in use"** tells the person that someone has that PIN (the spec requires the refusal), so those refusals count towards the wrong-PIN throttle.
- **Wrong-PIN throttle:** 3 free misses, then 1 s, 2 s, 4 s … up to 15 min, per iPad and per network address. A correct PIN doesn't reset it, so a kid can't use their own PIN to wipe the count; it fades after an hour without misses.
- **Repeat options:** every day, school days (Mon–Fri, not holidays), weekends and holidays, certain weekdays, every N days/weeks. Holidays are date ranges under Settings. An every-N task stays on the list for its whole period until done.
- **Editing tasks, rewards, people and settings needs a connection.** Marking done, approving, sending back and reward requests work offline.

## Layout

```
shared/    dates, schedules, points and eligibility rules (used by both sides)
server/    Fastify app, event store, projection, command rules, views, auth, watch page
server/storage/  asynchronous adapter contract, SQLite and DynamoDB implementations
server/test/  node:test suites (run with npm test)
client/    React + Fluent UI PWA (pages/, data/AppData.jsx = offline queue + sync)
scripts/   dev runner, icon generator, storage provisioning and local DynamoDB tests
docs/      design spec
```
