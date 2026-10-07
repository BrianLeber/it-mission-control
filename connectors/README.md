# Connectors

A connector is one YAML file that says **what to watch**, **how to read it** and **who may
see it**. Mission Control loads every `*.yaml` under this folder when it starts, except
`templates/`.

| Folder | What it holds |
|---|---|
| `public/` | Out-of-the-box public status feeds. They work without credentials, are marked `sensitivity: public`, and feed the public demo. |
| `templates/` | Starting points for your own systems (Microsoft 365 tenant health, Jamf Pro, Front, HTTP checks, heartbeats, webhooks). Copy one, fill it in, and save it in your instance or a private folder. |

Add a connector in any of three ways:

1. **Pull request** to this repository, for anything public and reusable. CI validates
   every file.
2. **Web UI** (Connectors → New), for anything specific to your organization.
3. **An AI assistant over MCP.** It drafts and tests the connector; a person adds the
   credentials and enables it. See "Building connectors with an AI assistant" in
   [`docs/DESIGN.md`](../docs/DESIGN.md).

Keep `sensitive` and `secret` connectors **out of this public repository**. A file name
alone can reveal what you run. Add those through the UI, or point `IMC_CONNECTORS` at a
private folder.

## File format

```yaml
id: github                 # lowercase, digits, dashes; unique
name: GitHub
group: Public SaaS         # section on the board
icon: { mono: GH, color: "#24292f" }
link: https://www.githubstatus.com/   # where "Open source" goes
sensitivity: public        # public | guest | viewer | sensitive | secret (default: viewer)
groups: []                 # selective access: only these groups can see it
driver: statuspage         # how to read it (below)
every: 1h                  # normal poll interval
fast_every: 5m             # poll interval while not operational
release: 2                 # clean polls needed before an issue clears
grace: 2                   # NO SIGNAL after this many intervals without a good reading
options:                   # driver-specific
  url: https://www.githubstatus.com/api/v2/summary.json
```

Credentials never go in the file. Write `${secret:name}` and store the value under
**Settings → Credentials** (or `npm run cli -- secret:set name`).

## Drivers

| Driver | Reads | Typical use |
|---|---|---|
| `statuspage` | Atlassian Statuspage `summary.json`: incidents, maintenance, components | Most SaaS status pages |
| `slack-status` | Slack's status API | Slack |
| `google-incidents` | Google `incidents.json` | Google Workspace, Google Cloud |
| `ms-graph-service-health` | Microsoft Graph service health (your tenant) | Microsoft 365 |
| `rss` | Any RSS or Atom feed; recent unresolved items are issues | AWS and vendors with feeds only |
| `json` | Any JSON API, judged by declarative rules | Jamf health, Front queues, vCenter, anything with an API |
| `http` | Status code, body text, response time | Internal servers and web apps |
| `heartbeat` | Pings from your jobs; silence becomes NO SIGNAL, then DOWN | Backups, cron jobs, appliances |
| `webhook` | JSON pushed to us: `{"key","state","summary"}` | NinjaOne, UniFi, scripts, Zapier |

Run `npm run cli -- poll <id or file.yaml>` to see what a connector would show right now.

## Out-of-the-box list

Each URL follows the vendor's documented public endpoint. This repository's CI can't reach
external sites, so each one is confirmed on its first live poll. A wrong URL shows up as
**NO SIGNAL** with the error on the card, never as a false OK.

| Service | Driver | Endpoint |
|---|---|---|
| GitHub | statuspage | www.githubstatus.com |
| Zoom | statuspage | status.zoom.us |
| Atlassian Jira / Confluence | statuspage | jira-software / confluence .status.atlassian.com |
| Cloudflare | statuspage | www.cloudflarestatus.com |
| Dropbox | statuspage | status.dropbox.com |
| Box | statuspage | status.box.com |
| 1Password | statuspage | status.1password.com |
| Twilio | statuspage | status.twilio.com |
| Claude | statuspage | status.claude.com |
| Jamf Cloud | statuspage | status.jamf.com |
| Slack | slack-status | slack-status.com/api/v2.0.0/current |
| Google Workspace | google-incidents | google.com/appsstatus/dashboard/incidents.json |
| Google Cloud | google-incidents | status.cloud.google.com/incidents.json |
| AWS | rss | status.aws.amazon.com/rss/all.rss |

**Known gaps.** Microsoft 365 has no keyless public feed; use the Graph template with your
tenant. Okta's status site has no documented JSON or RSS feed; it needs a small dedicated
driver. Both are good first contributions.
