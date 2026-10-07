# it-mission-control

A quick-look IT status board. It shows the **current state** of public SaaS, your own
platforms and internal infrastructure, with peak-hold status borders, a compressed-time
history, and a springboard to each source. Alerts open an incident and keep it lit until
the clear arrives, so you never have to line up "FAILED" and "RESOLVED" messages yourself.

- **Design and decisions:** [`docs/DESIGN.md`](docs/DESIGN.md)
- **Connectors** (what to watch, and how to add more): [`connectors/README.md`](connectors/README.md)
- **Prototype:** open [`prototype/index.html`](prototype/index.html) in a browser. It runs on
  simulated data. Keys `1` `2` `3` switch views, and `F` goes fullscreen on the board.

## Run it

Needs Node 22.18 or newer. There is no build step, and SQLite is built into Node.

```sh
npm install
IMC_PASSWORD='choose-a-long-password' npm run cli -- user:add admin --role instance_admin
npm start                       # http://localhost:8080
```

Sign in, and the 15 public connectors start polling within 30 seconds. To add your own,
copy a file from `connectors/templates/`, then store any credentials it references:

```sh
printf '%s' 'token-value' | npm run cli -- secret:set front_api_token
npm run cli -- poll connectors/templates/front-queue.yaml    # see what it would show
```

| Setting | Default | |
|---|---|---|
| `IMC_PORT` / `IMC_HOST` | `8080` / `0.0.0.0` | |
| `IMC_PUBLIC_URL` | `http://localhost:8080` | Used in ping and webhook URLs. `https://` turns on Secure cookies |
| `IMC_DB` | `data/imc.db` | |
| `IMC_CONNECTORS` | `connectors/` | Point it at a private folder for your own connectors |
| `IMC_SECRET_KEY` | (generated into `data/secret.key`) | 32 bytes, base64. Back it up: credentials can't be decrypted without it |

## Pieces

| | |
|---|---|
| **Incidents** | Each alert is a record with the vendor's reference (e.g. SP1489449), timeline and notes. Track an open one, and it's archived automatically when it closes; archive closed ones to keep them past 90 days. The **Log** view (key `4`) searches them all. |
| **TV boards** | An admin chooses *Allow a board* and creates a one-time code; the TV opens `/pair`. Boards are read-only, last 30 days, and can be reauthorized without re-pairing. |
| **AI-assisted connectors** | `POST /mcp` with an API token (`npm run cli -- token:add admin`). The assistant drafts and tests connectors; a person adds credentials and enables them. |
| **Public demo** | `npm run cli -- snapshot` writes `site/index.html` and `site/status.json`: a static, read-only status page. The *Public demo* workflow publishes it to GitHub Pages. |
| **Webhooks and heartbeats** | `POST /api/ingest/<id>` and `/api/ping/<id>/<token>`. An admin gets the URLs from `GET /api/connectors/<id>/endpoints`. |

```sh
npm test            # unit and end-to-end tests
npm run typecheck
npm run validate    # every connector file and template
```
