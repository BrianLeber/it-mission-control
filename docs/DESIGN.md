# IT Mission Control: design

A quick-look status board for everything IT depends on. It shows the **current state** of
each service, how long it has been in that state, and a compressed history, and it links
straight to the source for detail.

It fixes a specific problem. Alerts land in Slack and Front as one-off snapshots. You
can't tell what is still broken, or when something cleared, without lining up "FAILED"
and "RESOLVED" messages yourself. Mission Control keeps that state for you: it opens a
thing on alert, keeps it lit, and closes it when the clear arrives.

Prototype: [`prototype/index.html`](../prototype/index.html) (open it in a browser; it uses
simulated data and a scripted demo feed).

---

## 1. Design principles

Taken from game HUDs, watch complications, mixing desks, and the classic Windows Task
Manager ("TMOG"):

1. **Every pixel has a job.** A card shows five things and nothing else: brand icon, name,
   current state (the border), time in state, and history. Everything else lives one click
   away in the side panel.
2. **Healthy is quiet, trouble is loud.** Green borders are dimmed so a wall of healthy
   services recedes. Only off-nominal states use full color, glow or motion. On a TV, motion
   is reserved for DOWN so the eye goes straight to it.
3. **The border is the state; the strip is the past.** The outline of a card (or the name
   pill in list view) is always the *current* state. The history strip never decides the
   border color.
4. **Peak and hold, like a clip LED.** When a check goes red, the border flashes, then stays
   red until it clears. After it clears, a fading **PEAK** tag and corner notch stay for
   30 minutes. Someone glancing at the TV can tell that something just happened, even if
   it has already recovered.
5. **Attack and release.** As on an audio compressor, entering a bad state is fast and
   leaving it is deliberate. A check needs N consecutive good readings to clear, which
   stops a flapping check from strobing the board.
6. **State is never color alone.** Each state has a glyph (◆ ▲ ○ ■ ◇ ●) and a word, so the
   board stays readable for colorblind viewers and on washed-out TVs.
7. **Springboard, not a destination.** The side panel always leads with "Open source ↗".
   Mission Control tells you *where to look*; the vendor, Jamf, Ninja or Front is where you
   act.

## 2. States

| State | Color | Glyph | Meaning | Enters when | Leaves when |
|---|---|---|---|---|---|
| **DOWN** | red | ◆ | Hard failure or major outage | Source reports major/critical, a job fails, or heartbeats are missed past the hard limit | A clear signal, then the release window passes |
| **DEGRADED** | yellow | ▲ | Partial outage, threshold breach, alerting | Minor incident, metric over threshold | Same as above |
| **SNOOZED** | orange | ■ | A signed-in person has seen it and silenced it for a set time. It is still not fixed. | Someone snoozes a DOWN, DEGRADED or NO SIGNAL for 15m, 1h or 4h | The signal clears, the snooze runs out, or it gets worse |
| **NO SIGNAL** | grey, dashed | ○ | We don't know. Data is stale or the source is unreachable | No poll, ping or mail inside the expected interval × grace | Any fresh signal |
| **MAINTENANCE** | blue | ◇ | Expected downtime | A maintenance window is active (vendor-scheduled or ours) | Window ends |
| **OPERATIONAL** | green (dim) | ● | All good | A clear signal | — |

Rules:

- **Severity order** (sorting and history aggregation): DOWN > DEGRADED > NO SIGNAL > SNOOZED > MAINT > OK. Parked checks sort after all of them.
- **Snoozes belong to the incident, not the check.** A snooze needs a signed-in user and is
  always time-boxed. If it runs out while the issue is still open, the check re-arms to its
  previous state and flashes again. It also re-arms early if the snoozed incident gets
  worse (DEGRADED to DOWN) or a new incident opens. The card counts down the time left
  ("2h 47m left"). Finer rules (who can snooze what, maximum length, notes required) are
  still to be designed.
- **Unexpected statuses** (a value the adapter doesn't recognize, or a classifier result
  below the confidence threshold) show orange with a "needs review" tag. That keeps them
  visible without claiming an outage.
- **NO SIGNAL stays grey** (decided). "We can't see it" is a different problem from "it's
  broken" and needs a different fix.
- **Explained history turns blue.** After an outage, someone (or the vendor's postmortem
  feed) can mark the incident as explained or planned. Its history cells repaint blue. The
  border is unaffected because that outage is over.

### Noise controls: false alarms and parked checks

Not every alert deserves a light. There are two tools, and they do different jobs:

| | **False alarm** | **Park** |
|---|---|---|
| Use for | This alert was wrong | This is real, but it can wait (the AP that keeps dropping with no user impact) |
| Effect now | Closes the incident, with no PEAK hold | The check leaves "Needs attention", stops flashing, isn't counted in the header and never reorders the board |
| History | The alert chain repaints as **× false alarm** (dim grey) and is left out of availability figures | Keeps recording the real state, so you can still see the flapping |
| Card | Normal | Dashed neutral border, a **PARKED** tag next to the underlying state, the reason and the "until" date, in a **Parked** tray at the bottom |
| Ends | — | On its review date (it comes back lit if it is still bad), when someone unparks it, or through an escalation guard (e.g. DOWN for more than 4h, or more than N sibling APs affected) |
| Feeds | Rules and classifier: a negative example and a suggestion to tighten or suppress the rule | The weekly digest: "parked items past their date" |

Both actions need a signed-in user, record who did it and why, and appear in the signal
log.

## 3. The compressed-time history strip

Task Manager's scrolling graph, folded so the recent past gets the most room. The strip is
cut into four zones. Each zone holds more time per cell than the one to its right:

```
|  4w → 7d   |   7d → 24h   |   24h → 1h    |      last hour       | now
|  3 × week  |   6 × day    |  23 × hour    | 30 × 2 min (cards)   |
|            |              |               | 60 × 1 min (list)    |
```

- **Cell color** is the worst state in that bucket (severity order above, with explained
  incidents counted as MAINT).
- **Cell brightness** is the share of the bucket that was affected. A 10-minute blip in a
  one-week cell is a dim sliver; a day-long outage is fully lit. Coarse buckets stay honest
  this way, because a single bad minute doesn't paint a whole week red.
- Healthy cells are drawn at ~20% green, so trouble stands out.
- "Not yet monitored" is drawn as empty track, which is different from healthy.
- Hovering a cell shows its time range, state and share affected.

Storage follows the same shape: raw signals are kept for 48h, then rolled into hourly
buckets for 30 days, then daily buckets for a year. That makes the strip cheap to render
for 100+ checks.

## 4. Views

| View | For | Notes |
|---|---|---|
| **Cards** | Desk use | Grouped by Public SaaS / Our platforms / Infrastructure. With **Auto-focus** on, anything needing attention rises into a "Needs attention" section, followed by "Planned". Healthy groups sort recently-recovered first, so PEAK tags stay near the top. |
| **List** | Density, triage | One row per check. The status color sits on the name pill. Wider history (1-minute cells for the last hour). On narrow screens, rows stack. |
| **Board** | TV / NOC wall | Designed to fit **1920×1080** with no scrolling (verified for about 18 checks; past about 40 it needs group roll-ups). No controls to fiddle with. Attention items are big; healthy checks collapse to small tiles with a mini history. A "recent changes" ticker along the bottom answers "did that clear?" ("14:02 Slack ● OK after 9m"). Requests a screen wake lock; `F` toggles fullscreen. |
| **Side panel** | Click any card or row | Current state, **Open source ↗**, snooze, false alarm, park or clear, signal facts (source, interval, last heard), a full-width history strip, and the raw signal log. |

**Themes:** dark is the default and suits a TV. Light mode puts a **solid status banner
behind each service name**, because thin colored borders wash out on white. Healthy checks
get only a faint tint, so trouble still stands out. Status text darkens in light mode to
stay readable. Auto follows the OS; the header toggle overrides it per browser.

**Header master meter:** one LED segment per check, sorted by severity, plus counts per
state. It works like the master bus on a mixing desk: the whole estate in one glance,
readable from across the room.

**Auto-focus (stage 2):** the prototype already reorders by severity, then by recency, and
animates the moves so they read as movement rather than a jump. The production version adds:

- A **reorder cooldown** on the TV (e.g. at most once every 30s) so the layout doesn't
  churn.
- **Pins** for checks that should always hold their position.
- Weighting by **business impact** (e.g. Okta DOWN outranks a GitHub DEGRADED).

### Board pairing (no user account on the TV)

A board shows status with no signed-in user and has read-only access:

1. A signed-in admin chooses **Allow a board**, names it ("Lobby TV") and creates a
   one-time code (`5TM-9XX`, 10-minute expiry, no ambiguous characters). The box has a ×
   and closes on Escape, an outside click or a view change.
2. The TV opens `/pair`. Unpaired, it shows only a code entry screen with no status data.
3. A matching code is **spent on first use**. It becomes a **board token**, stored hashed
   and valid for **30 days**, with the clearance chosen at pairing (capped at the admin's own,
   and never `secret`). The admin's box closes on its own and says "Lobby TV paired. That
   code no longer works." The board is read-only.
4. **Expiry without re-pairing.** When a board's 30 days run out, the TV shows "Board access
   expired" and nothing else. In the admin's list it reads "Expired Oct 4" with
   **Reauthorize**. Reauthorizing extends the same token by 30 days, and the TV reconnects
   within a minute without anyone touching it. Boards within 7 days of expiry show "Expires
   in 5 days" with Reauthorize too.
5. The **Allow a board** button gets a yellow border when any board expires within 7 days,
   and a red one when any has expired.
6. Revoke removes a board immediately. Redeeming codes is rate-limited per address.

Typing on a TV remote is clumsy, so we can add the reverse flow later: the TV shows the code
and the admin types it on their laptop. The same token model supports both.

**TV hygiene:** a dark ground, a dimmed healthy state and a slow pixel shift protect
OLED/plasma panels from burn-in. Minimum type size is set for reading at about 3 m.

## 5. Architecture

```mermaid
flowchart LR
  subgraph Sources
    P[Pollers<br/>cron: status APIs,<br/>Jamf, Ninja, Front, vCenter]
    W[Webhooks<br/>Ninja, Statuspage,<br/>Jamf, anything]
    H[Heartbeats<br/>/ping/:check]
    E[Email<br/>alert mailbox]
  end
  P --> N[Normalizer]
  W --> N
  H --> N
  E --> R[Rules engine] --> N
  R -. no match / low confidence .-> C[Classifier model] --> N
  N --> S[(Signals)]
  S --> X[Incident engine<br/>open · ack · clear<br/>debounce · maintenance · staleness]
  X --> DB[(Incidents + rollups)]
  X --> SSE[Live stream SSE]
  SSE --> UI[Cards / List / Board]
  UI -- ack / clear / explain --> X
```

### Core model

- **Check**: something that has a state. `id, name, group, icon, source_url, adapter,
  expected_interval, grace, release_count, impact`.
- **Signal**: an immutable observation. `check_id, observed_at, state, summary,
  correlation_key, origin, raw, confidence`.
- **Incident**: an open-to-closed span for one `(check_id, correlation_key)`. It records
  open, worst, ack (who, note), clear (by signal or by hand) and explanation. **Current
  check state = the worst open incident**, overridden by an active maintenance window, or
  NO SIGNAL when stale.
- **Maintenance window**: from vendor feeds (Statuspage "scheduled" incidents, M365 planned
  maintenance) or entered by us.

A check can have several open incidents at once. NinjaOne might report "disk 92%" and
"service stopped" on FS01; the card shows the worst, and the panel lists both.

### Ingest adapters

**Cadence defaults:** proactive polls run **hourly** by default, and every few hours for
slow-moving checks such as certificate expiry and license counts. Each check sets its own
interval. A polled check that isn't operational **speeds up to every 5 minutes** until it
clears (the card shows `poll 5m ▴`), so recovery is caught fast without hammering APIs the
rest of the time. Push sources (webhooks, heartbeats, email, Slack) arrive when they arrive.
NO SIGNAL only applies where an interval is expected (2× interval grace by default). We will
tune all of this during testing.

| Kind | Examples | Notes |
|---|---|---|
| **Poll** | Statuspage-hosted status pages (Zoom, GitHub, Atlassian and many others expose `/api/v2/summary.json`), Slack's status API, Microsoft Graph service health (`admin/serviceAnnouncement/healthOverviews` and `/issues`, needs `ServiceHealth.Read.All`), Google Workspace status JSON, Jamf Pro (`/healthCheck.html` plus API checks), NinjaOne API (device and alert state), Front API (queue snapshot: open count, past-SLA count, oldest), vCenter REST (hosts, triggered alarms) | Each adapter maps vendor states onto our six. Cadence is per check. **Endpoints to be confirmed against each vendor's current docs during build.** |
| **Webhook** | NinjaOne alert webhooks, Statuspage subscriptions, Jamf webhooks, generic JSON | `POST /api/ingest/:source` with a per-source secret or HMAC. A generic schema lets anything that can send JSON report state. |
| **Heartbeat** | Cron jobs, backup scripts, Linux and Windows boxes | `GET/POST /api/ping/:check/:token` (and `/fail`). A missed ping moves the check to NO SIGNAL, then to DOWN past a hard limit. Same idea as healthchecks.io. |
| **Slack channel** | `#it-alerts`, `#it-network-alerts`, vendor bots posting into Slack | Slack Events API (a bot added to the alert channels). Messages go through the same rules → classifier pipeline as email, and thread replies count as follow-ups. This is likely the **first** text source, since most alerts already land in Slack. |
| **Email** | Veeam, UPS, vendor notices, anything that only emails | An alert mailbox (an M365 shared mailbox read through Graph, or forwarding into an inbound-mail endpoint). See below. |

For Windows and Linux servers, the plan is to **lean on NinjaOne** (it already watches them)
rather than run a second agent. Heartbeats cover the gaps (cron jobs, appliances, things
Ninja can't see).

### Email: open on alert, close on follow-up

1. **Parse**: sender, subject, body, thread headers (`Message-ID`, `In-Reply-To`,
   `References`).
2. **Tier 0, deterministic rules** (most mail): sender and subject patterns map to
   `check`, `state` and `correlation_key`, plus whether the mail *opens* or *clears*. For
   example:
   `from:veeam@ subject:/\[(Failed|Warning|Success)\] (?<job>.+?) / → check=veeam-{job}, key={job}, Success ⇒ clear`.
   Thread headers and normalized subjects (with `RE:`, `[RESOLVED]` and similar stripped)
   tie a resolution to the alert it closes.
3. **Tier 1, "System 1" classifier** (anything rules don't match): a small, fast model
   that makes a quick call on a single message. It doesn't reason over the whole system.
   It reads the message and returns structured JSON:
   `{check_id | "unknown", state, correlation_key, opens|clears, confidence, one_line_summary}`.
   - Confidence at or above the threshold: it acts, and the log shows
     `classified by model (0.91)`.
   - Below the threshold, or an unknown check: an orange **needs review** item holding the
     raw mail. Confirming it offers to **save a rule**, so repeat mail moves down to Tier 0
     over time.
   - The model can only map to existing checks. It never creates checks, and it never
     clears an incident a human snoozed or parked without a matching key.
4. Every action keeps a link back to the original message.

The same pipeline reads Slack alert channels, where a thread reply or a later "back
online" post closes what the first post opened.

### Digest (daily / weekly)

An LLM-written summary, posted to Slack (and optionally email). It is built from the
incident store, **not** from raw alerts, so it reports state and not noise:

- What broke, for how long, and whether it is cleared. Each item links to its card.
- What is still open, snoozed or parked, with parked items past their review date called
  out.
- Repeat offenders and flapping checks, which are candidates for parking or a fix.
- False-alarm counts per rule, which are candidates for tuning.
- Weekly: availability per service from the history buckets, with false alarms left out.

The model only summarizes facts we pass in as structured data. Every number in the digest
comes from the database.

### Stack (as built)

- **Node 22 running TypeScript directly** (no build step). One process holds ingest, the
  incident engine, the poller, the API, SSE and MCP. Dependencies are kept small: `yaml`,
  `zod` and the MCP SDK.
- **SQLite** built into Node (`node:sqlite`): one file and easy backups, with a clean path to
  Postgres when needed.
- **Front end**: the prototype page itself. The server injects a mode flag and the page
  switches from demo data to the live API and SSE. A framework can come later if the UI
  outgrows one file.
- **Deploy**: a single container or VM. Put it behind HTTPS (`IMC_PUBLIC_URL=https://…`
  turns on Secure cookies). Username and password for now; SSO (OIDC) slots in beside it
  later.
- **Config as code**: connectors are YAML in `connectors/`. Custom connectors and AI drafts
  live in the database.

Code map: `src/connectors` (schema, drivers, safe fetch), `src/engine` (incident engine,
poller, per-viewer views), `src/access` (policy, identity), `src/secrets` (vault),
`src/http` (API, SSE, UI), `src/mcp` (assistant tools), `src/cli.ts`.

## 6. Connectors: out of the box, customizable, AI-assisted

A connector is one YAML file: what to watch, which **driver** reads it, how often, and who
may see it. Nine drivers cover most needs without code: Statuspage, Slack, Google incident
feeds, Microsoft Graph service health, RSS/Atom, rule-based JSON, HTTP, heartbeats and
webhooks. See [`connectors/README.md`](../connectors/README.md).

- **Out of the box:** `connectors/public/` ships 15 public status feeds (GitHub, Zoom,
  Slack, Google Workspace and Cloud, Atlassian, Cloudflare, Dropbox, Box, 1Password, Twilio,
  Claude, Jamf Cloud, AWS). They run with no setup.
- **Templates** for your own systems: Microsoft 365 tenant health (Graph), Jamf Pro health
  check, Front queue snapshot, HTTP check, backup heartbeat, generic webhook.
- **Growing it over time:** add a file by pull request. CI validates every file, and
  `npm run cli -- poll <file>` shows what it would display. Organization-specific connectors
  go in through the UI or a private folder, never the public repo.
- **Self-checking:** a wrong URL, a changed API or a missing credential turns the card grey
  (NO SIGNAL) with the reason. It never shows a false OK.

### Credentials

Connectors reference credentials as `${secret:name}`. Values are encrypted at rest
(AES-256-GCM, with a key in `IMC_SECRET_KEY` or `data/secret.key`). People with credential
rights can **set, replace and delete** them in the web UI, but nothing can **read one
back**: not the API, not MCP, not the UI. The poller decrypts a value only for the request
that needs it and scrubs it from any error text.

### Building connectors with an AI assistant (MCP)

`POST /mcp` is a Model Context Protocol endpoint, so any MCP-capable assistant (Claude or
others) can help build connectors. An admin creates an **API token** with the
`manage_connectors` scope, the same way they would allow a board, and gives it to the
assistant.

| Tool | Does |
|---|---|
| `list_drivers`, `describe_driver` | What can be read, the options schema, a full example |
| `list_connectors`, `get_connector` | What exists (within the token's clearance) |
| `validate_connector` | Schema check, plus any credentials it references that aren't set yet |
| `test_connector` | One live poll with stored credentials; returns the state and issues it would show |
| `save_connector_draft` | Saves it **disabled** |
| `list_credentials`, `request_credential` | Names and whether each is set; creates an empty slot with a description |

The split is deliberate: **the assistant composes, a person approves.** The assistant
never sees a credential value and can't enable anything. A person pastes the credential
into the slot the assistant requested, reviews the draft and enables it. Enabling turns
the draft into a normal custom connector, and the audit log records who did each step.

## 7. Access control

There are two independent questions, and the server answers both where the data is read
(API, live stream, MCP, digest), never only in the UI.

**Role: what you can do**

| Role | View | Snooze / park / false alarm | Connectors and credentials | Boards and tokens | Users | Instance settings |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Global admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (all instances) |
| Instance admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Dashboard admin | ✓ | ✓ | ✓ | ✓ | — | — |
| Technician | ✓ | ✓ | — | — | — | — |
| Viewer | ✓ | — | — | — | — | — |
| Guest / board | ✓ | — | — | — | — | — |

**Clearance: what exists for you.** Every connector has a sensitivity level, and every
person, board and token has a clearance:

`public` (anyone, even with no code, if the instance enables the public board) ·
`guest` (paired boards, guests) · `viewer` (signed-in staff) · `sensitive` · `secret`

On top of that, **selective access**: a connector can list `groups`, and then only members
of at least one of those groups can see it, whatever their clearance.

Rules that make "even knowing it exists is a risk" hold:

- A check above your clearance is **absent**: no card, no LED, no count, no ticker line, no
  live-stream event, no MCP listing. A hidden check and a missing one return the identical
  404.
- `secret` is never a default, not even for admins. It has to be granted explicitly, and
  the grant is audited. Boards can never hold `secret`.
- Nobody can grant a role or clearance higher than their own. API tokens are capped by
  their issuer's **current** clearance, so demoting a person shrinks their tokens.
- Sensitive and secret connector files stay out of the public repository; a file name can
  be the leak.

Sign-in is username and password: scrypt hashes, 7-day sessions stored hashed, throttling
after repeated failures, and a CSRF header on every cookie-authenticated write. SSO (OIDC
with Entra ID or Okta) is the next identity option and fits beside this. Instance and
global roles are modelled now; running several instances from one deployment is reserved
for later.

## 8. Public demo (down-detector)

A public, read-only page for the common SaaS services, useful as a live demo and as a
down-detector anyone can open.

- Browsers can't fetch most vendor status APIs directly, because of CORS. So a scheduled
  job (`npm run cli -- snapshot`, run by the included GitHub Actions workflow) polls the
  **public** connectors and publishes `status.json` with the page as a static site, for
  example on GitHub Pages. That also keeps vendor traffic to one request per interval,
  however many people visit.
- The page runs in **public mode**: no sign-in, no actions, no boards. **History is kept in
  the visitor's browser** (local storage, 7 days) and starts when they first open the page;
  a notice says so. The strip shows "not monitored yet" before that, so it never pretends
  to know more than it does.
- Only connectors marked `public` are included. The demo build never touches an
  instance's database or credentials.

## 9. Roadmap

| Phase | Scope |
|---|---|
| **0. Prototype** ✅ | Visual language, states, history strip, three views, side panel, demo feed, light theme |
| **1. Core + public SaaS** ✅ built, needs a real deployment | Incident engine (debounce, staleness, maintenance, adaptive polling), SSE, 15 public connectors, sign-in, roles and clearance, board pairing with expiry, credential vault, MCP authoring, public demo build |
| **1b. Admin UI** | Screens for connectors (review drafts, edit YAML, test), credentials, users and groups, tokens, instance settings. The API for all of these exists now |
| **2. Our platforms** | Jamf, NinjaOne (API and webhook), Front snapshots, vCenter, using the templates. Snooze, park and false alarm already work against the live engine |
| **3. Slack + email** | Slack alert channels first, then email. Tier 0 rules, open and close on follow-up, needs-review queue |
| **4. Smarts** | System 1 classifier, rule suggestions from false alarms, daily and weekly digest, auto-focus cooldown and pins, impact weighting |
| **5. User side** (stretch) | Per-user views and filters, ack notes and handoff, notifications that link to the card instead of repeating the alert |

## 10. Decisions and open questions

**Decided**

- Classifier: a small, fast "System 1" model behind the deterministic rules.
- NO SIGNAL stays its own grey state.
- Orange is **SNOOZED**: a signed-in user silences a critical alert for a set time. The
  details are to be designed.
- Slack alert channels are a primary text source. A daily or weekly LLM digest is planned.
- Check frequency varies by service. Proactive polls default to hourly or every few hours;
  push sources are event-driven. Tune during testing.
- Target 1080p and web view. TVs pair through an admin-issued code and get no user account.
- Noise controls: **False alarm** and **Park** (section 2).
- Light theme uses status banners behind names.
- Pairing codes are single-use; boards last 30 days and can be reauthorized without
  re-pairing.
- Connectors: OOTB public feeds in the repo, templates for your own systems, custom ones in
  the UI, AI-assisted authoring over MCP where people hold the credentials and the enable
  switch.
- Access: six roles × five clearance levels, plus group-based selective access, enforced
  server-side. Username and password now, SSO later.
- Public demo: static snapshot plus browser-only history.

**Still open**

1. **Servers:** is NinjaOne the source of truth for Windows and Linux servers and VMware
   hosts, or do we need direct checks? (TBD)
2. **Snooze rules:** who can snooze, maximum length, and whether a note is required.
3. **Classifier hosting:** can alert text go to a hosted model, or must it run locally?
4. **Hosting:** where the instance runs (it needs to reach internal servers for HTTP checks).
   SSO provider when we add it.
5. **Sound:** should a new DOWN chime on the board?
6. **Board clearance default:** boards default to `guest` (public and guest checks only).
   Should the office wall boards see `viewer` checks such as Jamf and Front?
