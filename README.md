# Chores

A household chores app for the iPads: mark a task done (alone or with helpers), someone else approves it, points go towards real-world rewards. The design is in [docs/design-spec.md](docs/design-spec.md).

- **Front end:** React + Vite + Fluent UI (v9), installable as a PWA that opens and queues actions offline.
- **Back end:** Node + Fastify + SQLite (better-sqlite3). An append-only event log is the main table, and all state is derived from it.
- **Live updates:** server-sent events, so Approve badges update as soon as someone marks a task done.

## Quick start (development)

```sh
npm install
npm run dev        # API on :3000, app on http://localhost:5173 (also on your LAN IP)
npm test           # server rules: approvals, points, eligibility, retries, rollover, login
```

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
| `DB_PATH` | `./data/chores.db` | SQLite file (the whole household history) |
| `TLS_CERT`, `TLS_KEY` | unset | PEM files; turns on HTTPS and `Secure` cookies |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy, so PIN throttling sees real client addresses |
| `TZ` | system | The household time zone. Lists roll over at midnight in this zone |

### HTTPS is needed for the iPads

iPadOS only runs service workers (offline mode, home-screen install that keeps working) on HTTPS, or on `localhost`. Over plain `http://nuc.local` the app works online but won't open offline. Two simple ways to get a certificate the iPads trust:

- **mkcert:** `mkcert -install && mkcert nuc.local 192.168.1.20`, then install the generated root CA on each iPad (AirDrop the `rootCA.pem`, install the profile, then enable it under *Settings → General → About → Certificate Trust Settings*).
- **Caddy** in front of the app with `tls internal`. Same idea; trust Caddy's root CA on the iPads and set `TRUST_PROXY=true`.

Then on each iPad, open the site in Safari, tap **Share → Add to Home Screen**.

**Keep it on the home network.** PIN sign-in is rate limited, but a 6-digit PIN is not meant to face the internet, so don't port-forward this.

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

Run it with no username to list everyone. It uses the same `DB_PATH` as the server, is safe to run while the server is up, and records the reset in the event log. If you can still sign in (say, with your PIN), a grown-up can also set a new password under People → Edit.

**Backups:** everything is in `DB_PATH`. Back it up with `sqlite3 data/chores.db ".backup backup.db"` (safe while running).

### Apple Watch

A cut-down page at **`/watch`** lets you mark your own tasks done (on your own) and approve other people's. It's just a PIN box, then two buttons (My Tasks, Approve) that each open a list. Opening the main address on a screen narrower than 260 px also lands here, which is how to try it in browser developer tools (e.g. 198 × 242). The watch has no Safari app or address bar, so send the link once in Messages (to yourself, or to a kid's watch), pin that conversation, and tap the link to open it. Sign in with your PIN.

- It's plain HTML from the server with no JavaScript. Each tap is a form submit, so it only works while the watch can reach the NUC, and there's no offline mode.
- Each button carries an action id made when the page was drawn, so a double tap or a resubmitted form never counts twice.
- Helpers, sending back, rewards and editing stay on the iPad.
- **Not yet tried on a real watch.** Two things to check: whether the watch trusts the NUC's HTTPS certificate (installing the root CA on the paired iPhone may or may not be enough), and whether the watch keeps you signed in between visits. If it doesn't, you'll enter your PIN each time.

## Navigation

The home screen is just **My Tasks** and **Approve**, plus a small progress bar. Everything else is behind your avatar in the top corner: Rewards and Profile for everyone, Manage tasks, People and Settings for grown-ups, and Switch person. The points star also opens Rewards. Sign-in shows only the PIN keypad, with "Use username and password" underneath.

## How it works

- **Event log.** Every task edit, completion, approval, send-back, points award and reward spend is a row in `events`, which SQLite triggers make append-only. Balances, lists and the Approve queue are derived from it, and the server replays it into memory on start. Accounts and credentials live in `users`. Their changes are logged as events too, but hashes never are.
- **Occurrences.** A task's schedule produces occurrences with stable ids: `taskId/periodStart` for a household job, or `taskId/periodStart/userId` for an "everyone does their own" task. Yesterday's dishwasher and today's are separate, and a pending approval never expires at midnight.
- **Offline and retries.** Each iPad keeps the last state and its own queue of actions in IndexedDB. Every action has a UUID made on the iPad, and the server records it in `actions`. A resend after reconnecting returns the original outcome and never applies twice, so no double points. A task marked done at 23:50 and sent at 00:10 still counts for its own day, because the iPad's timestamp is used (sanity-checked: no more than 5 minutes ahead or 14 days behind).
- **One at a time.** Actions are handled synchronously in a single process, so two iPads approving the same task are checked in turn against its multiple-approvals setting.
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
server/test/  node:test suites (run with npm test)
client/    React + Fluent UI PWA (pages/, data/AppData.jsx = offline queue + sync)
scripts/   dev runner, icon generator
docs/      design spec
```
