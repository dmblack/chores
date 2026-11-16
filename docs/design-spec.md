# Chores App — design spec

Updated 15 November 2026 following the design discussion.

A super-simple household chores app for Harrison, Dana and Dusty: mark a task done on your iPad, on your own or with someone else, and another person approves it.

This revision records the agreed task options, quick setup flow and React/Fluent UI choice. Items still needing a decision are listed at the end.

## Users and login

- Each person has their own account (Dusty, Harrison, Dana; more can be added).
- Two ways to sign in, both on the login screen: username and password, or just a 6-digit PIN with nothing else. The PIN alone identifies the account, so PINs must be unique across all users; each user sets their own PIN in their profile, and the app refuses one already in use.
- Sessions are long-lived (a month or more, refreshed on each use) so nobody logs in again every week.
- Wrong PIN attempts are rate limited on the server (a short, growing delay per device after a few misses) since there is no username to narrow the guess. Fine for a home network; do not expose the PIN login to the internet.

| Field         | Notes |
|---------------|-------|
| id            | Stable unique id; every event in the log points at it |
| username      | Unique, used for password login |
| nickname      | Display name shown in the app |
| role          | Grown-up (admin: edit tasks, set rewards, approve redemptions) or kid |
| birth date    | Stored instead of age, so it never goes stale; age is worked out from it and drives task eligibility |
| password hash | Never the password itself (argon2 or bcrypt) |
| PIN hash      | Hashed the same way |
| active        | Switch an account off without deleting its history |

Not stored on the user: points balance and task history, which are derived from the event log.

## Landing page

Two big primary buttons, plus the small progress indicator described below:

1. **My Tasks** — today's list; tap a task to mark it done.
2. **Approve** — tasks others have marked done and are waiting for a tick. A small number badge in the top-right corner shows how many are waiting.

Reduced front end (agreed 16 November 2026): no app title or greeting. Sign-in shows only the PIN keypad, with username and password as a small link. Everything else (Rewards, Profile, and for grown-ups Manage tasks, People and Settings, plus Switch person) is in a menu behind the person's avatar in the top corner. The points star also opens Rewards. Watch-sized screens get the watch page instead (see Apple Watch).

## Task flow

A contributor is a person recorded as having helped complete a task. A completion records its contributor or contributors together.

| State          | Meaning |
|----------------|---------|
| To do          | Not done yet |
| Done (pending) | The contributor or contributors marked it done; waiting for someone else to approve |
| Approved       | Another account confirmed it |
| Sent back      | Approver said no, with a reason / what still needs doing |

- Collaboration is configurable for each task. When allowed, one completion can record several contributors; for example, Harrison and Dana unloading the dishwasher together.
- When collaboration is disabled, a completion has one contributor.
- You cannot approve your own task. For a shared completion, this applies to every contributor: approval comes from someone who did not contribute to that completion.
- A rejection must include a reason: a few tap-to-pick options plus free text.
- A sent-back completion goes back to its contributors' task lists with the reason shown.

### Multiple approvals

- Allow multiple approvals is a separate setting on each task.
- When disabled, the completion accepts one approval.
- When enabled, more than one other account may deliberately endorse the same completion. Record each accepted approval and who gave it.
- The first accepted approval makes the completion Approved. Additional approvals are endorsements; enabling them does not introduce a requirement to collect several approvals before the task is approved.
- The approval flow must make additional endorsements possible when enabled, including after the first approval.
- A second person's deliberate endorsement is distinct from an iPad resending an existing approval after reconnecting. Retrying the same action never creates a second action or reward.
- Approval rewards and contributor rewards are separate; see Rewards and the open decision about additional endorsements below.

## Tasks and success criteria

- Each task has a one-line success criterion so "done" is clear (for example, unloading the dishwasher means dishes put away in cupboards and drawers, not left on the bench). Some flexibility is fine.
- Tasks come from the daily list: morning, daytime (weekends/holidays), evening, and grown-up jobs, plus the mandatory ones (reading, have fun and play games).
- Lists reset each day; not-every-day jobs reset on their own schedule.
- Eligibility: a task can carry an optional minimum age (for example, the washing machine task needs age 10 or over). The app works out each person's age from their birth date and only offers a task to people who are eligible. No minimum set means anyone can do it.
- Ineligible tasks are hidden from that person's My Tasks list rather than shown greyed out, and the server rejects a completion that records an ineligible contributor. Collaboration does not remove the task's age requirement.

## Quick task setup and advanced settings

Task creation should be quick and easy. The main form contains:

| Field                | Purpose |
|----------------------|---------|
| Task name            | A short name for the chore |
| What counts as done? | The one-line success criterion |
| Points               | The task's completion-point value |
| When it repeats      | The recurrence schedule and applicable days |

A grown-up can create a task from this main form without opening advanced settings. The existing grown-up permissions for task administration still apply.

A collapsed **Advanced settings** section contains:

| Setting                  | Behaviour |
|--------------------------|-----------|
| Allow collaboration      | Choose whether a completion can include several contributors |
| How points are awarded   | Choose **Full points for each person** or **Split points equally** |
| Allow multiple approvals | Choose whether several other accounts can approve the same completion |
| Minimum age              | Optional age requirement for contributors |

- Each option is configured per task.
- The same advanced controls are available when editing an existing task.
- Quick creation uses defined defaults for advanced options. The default values have not yet been selected; see Decisions still open.
- Opening Advanced settings shows the current values.
- Show a compact summary of changed advanced settings on the form, for example: Collaboration allowed · Full points each.
- The existing list/category selection (morning, daytime, evening, grown-ups) remains editable in the task editor.

## Rewards (in-app currency)

### Points for doing the work

Contributors earn completion points for work that someone else approves. The task creator chooses How points are awarded for each task:

| Option                      | Meaning | Example: a 10-point task with two contributors |
|-----------------------------|---------|------------------------------------------------|
| Full points for each person | Every contributor receives the task's full completion-point value | 10 points each |
| Split points equally        | The task's completion-point value is divided equally among its contributors | 5 points each |

- Working together is supported as a valid way to complete a chore.
- The selected allocation rule should be visible before people volunteer or complete the task.
- With one contributor, either allocation mode gives that person the full task value.
- The rule for fractional shares, such as 10 points divided among three contributors, still needs a decision.

### Points for checking the work

- A person earns approval points for an accepted approval of someone else's work.
- When multiple approvals are enabled, each valid approving person can earn approval points for their endorsement.
- Approval points are separate from the completion-point allocation. Choosing Split points equally divides the contributors' completion points.
- Whether an additional distinct endorsement also awards completion points again to the contributors is still open. The allocation choices above define how completion points are distributed when awarded; they do not settle how often those points are awarded.
- Resending an already recorded action never produces another award.

### Spending and history

- No penalties for tasks not done; there may be a good reason (unwell, busy day). Earning points only adds to the balance.
- Points are redeemed for real-world rewards from a small catalogue (an extra treat, extra game time, pick the movie). A grown-up account sets the catalogue and the point values.
- Redemptions go through the same approve flow: the kid requests, a grown-up approves, points are deducted.
- Every earn and spend is an event in the log, so balances are derived and auditable.

## Admin, daily reset and progress

- A grown-up account can add, edit and remove tasks and their success criteria from inside the app, and set which list (morning, daytime, evening, grown-ups) and which days each task applies to.
- The daily lists roll over at midnight. Approvals still pending at rollover stay in the Approve queue until someone ticks or sends them back; they do not silently expire.
- Each scheduled occurrence is distinct, so yesterday's pending dishwasher task remains separate from today's task.
- The landing page shows a small "today's progress" bar for the logged-in person (approved tasks out of today's total) so the kids can see how close they are to game time.
- The distinction between shared household occurrences and activities each person must complete separately, including its effect on today's total, still needs to be specified.

## Nice-to-haves (later)

- Simple history view: what was done and approved, by whom, per day.
- Streaks or a bonus for a full day.

## Event log and offline

- The server keeps an append-only event log: who did what, when (for example "Harrison marked Unload dishwasher done at 18:40", "Dana approved at 18:52", "Dusty sent back: dishes left on bench"). Current task state is derived from the log, so nothing is ever silently overwritten and the history is the provenance.
- Shared completions record all contributors. Accepted approvals identify the approving account and the completion being endorsed.
- Task definitions, scheduled occurrences and submitted completions must be distinguishable, so actions refer to the correct job and submission.
- Each client (iPad) caches the last known state and its own unsent events. Offline, the app still opens from the home screen and shows the last list; marking done or approving is queued locally.
- On reconnect the client sends its queued events to the server and pulls any new ones. Approvals are only final once the server has them.
- Each queued action retains a stable identity across retries. The server applies that action and any associated points transactions once, even if it receives the action again.
- Concurrent approvals are checked against the task's multiple-approval setting. Distinct permitted approvals are recorded separately; retries of one approval are recognised as the same action.
- The server validates permissions, contributor eligibility and the applicable task rules before accepting queued actions.
- The central server is the single source of truth; clients never need to reconcile with each other directly.

## Technology

### Agreed

- JavaScript end to end: one language for front and back.
- Front end: React with Vite and Fluent UI, as a PWA (service worker + manifest) so it sits on the iPad home screen and works offline.
- Use the Fluent UI React component library for the interface. React and Vite were already in the original specification; Fluent UI was selected in the design discussion.

### Existing proposed implementation

- Back end: Node (Fastify or Express) with SQLite via better-sqlite3; the event log is the main table, state is derived from it.
- Realtime: server-sent events or a WebSocket so badges update when someone marks a task.
- Hosted at home on the NUC, reachable on the home network.
- Session: long-lived token in a secure cookie, refreshed on use.

Fastify versus Express and server-sent events versus WebSocket remain implementation choices.

### Apple Watch (added 15 November 2026)

- A very simplified page for the watch, opened from a link in Messages (the watch has no browser of its own, only a web view for links).
- Scope: **mark my tasks done** (solo, no helpers) and **approve other people's tasks**. Everything else stays on the iPad.
- Screens: the PIN box only (no title), then two buttons — My Tasks and Approve, each with a count — each opening its own list. Opening the main app on a screen narrower than 260 px goes to the watch page.
- Sign in with the PIN. Online only: no offline queue on the watch. The same server rules apply, including no approving your own work and no double counting on retries.

## Decisions (resolved 15 November 2026)

| Decision | Resolution |
|----------|------------|
| Defaults for quick creation | Collaboration **off**, multiple approvals **off**, points **Full points for each person**. The form's summary line only appears once a setting differs from these defaults. |
| Completion rewards after additional endorsements | **Once per completion.** Contributors earn completion points on the first accepted approval only. Every accepted approval (first and additional endorsements) earns its approver approval points. |
| Equal splits that produce fractions | **Round up for everyone.** Each contributor gets `ceil(points ÷ contributors)`, so 10 points shared by 3 gives 4 · 4 · 4. Points stay whole numbers; the total paid can exceed the task's value. |
| Shared chores versus personal activities | **A per-task type.** *Shared* tasks have one occurrence per schedule period for the household and leave everyone's list once marked done. *Everyone does their own* tasks give each eligible person their own occurrence (for example, reading). Today's progress for a person = their own personal occurrences + the shared occurrences they contributed to. |

## Revision basis and reference

- Original requirements: the supplied Chores App — design spec.md, including accounts, permissions, task flow, age eligibility, rewards, daily rollover, the event log, offline operation and the proposed home-hosted stack.
- Agreed additions: the design discussion on 15 November 2026 covering collaboration, per-task point allocation and multiple approvals, quick setup with advanced settings, and React with Fluent UI.
- Fluent UI implementation reference: Microsoft's official Fluent UI repository, which identifies its React component library. A specific package version was not selected in the discussion.
