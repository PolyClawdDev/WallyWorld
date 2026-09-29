# Going public

This world has never been on the public internet. Everything below has been
prepared and tested locally; what is left is the part that needs an account
with a hosting provider and a decision about money.

Read the cost section first. Nothing here provisions anything.

---

## What still has to be done by a human

Four things, in order. Nothing else is outstanding.

1. **Create a Render account** (or pick a different host — see "Render is a
   choice" below). Free to create; the workspace's Hobby plan is $0/month.
2. **Accept the cost.** The minimum credible bill is **$14/month** — the
   always-on web service ($7) plus the background worker ($7) — with a Free
   Postgres that **deletes itself 30 days after creation**. With a database
   that survives, **$20/month**. Full breakdown in the next section.
3. **Sync the Blueprint.** Point Render at this repository and let it read
   `render.yaml`. It will create four resources: `voxels-api`,
   `voxels-worker`, `voxels-web`, `voxels-db`.
4. **Paste four values into the dashboard** — Render prompts for each one,
   because they are marked `sync: false` and are deliberately not in the
   repository:
   - `voxels-api` → `SOLANA_RPC_URL_DEVNET` (the QuickNode URL; the access
     token is in the path, so this is a credential)
   - `voxels-worker` → `SOLANA_RPC_URL_DEVNET` (the same value)
   - `voxels-api` → `NPC_PAYEE_ADDRESS` (a public key, and optional to the point
     of being pointless: NPC payments are off on every deployment because the
     client has no transaction signer, so leave it unset)
   - Then correct `WALLY_PUBLIC_ORIGIN`, `WALLY_ALLOWED_ORIGINS` and
     `VITE_API_BASE_URL` to the hostnames Render actually assigned, and
     redeploy the static site so the new API URL is compiled into the bundle.

That is the whole remaining human action. There is no code left to write.

## What costs money

| Resource | Plan | Cost | Why not free |
| --- | --- | --- | --- |
| `voxels-api` | `0.5c-512mb` | **$7/mo** | A Free web service spins down after 15 idle minutes, and Render counts WebSocket messages on existing connections as idle. A spun-down world ends everyone's duel. |
| `voxels-worker` | `0.5c-512mb` | **$7/mo** | Background workers have no free plan at all. |
| `voxels-db` | `0.1c-256mb` | **$6/mo** | `free` works, but expires 30 days after creation, caps at 1 GB, has no backups and no pooling. |
| `voxels-web` | static | **$0** | Static sites have no compute plan. |
| Workspace | Hobby | **$0** | Includes 5 GB bandwidth and 500 build minutes; then $0.15/GB and $5 per 1,000 minutes. Outbound WebSocket traffic counts against bandwidth. |

**$14/month** to try it for 30 days, **$20/month** to keep it.

### Render is a choice

The application needs a long-lived Node process that can hold WebSockets, a
managed Postgres, a worker, and static hosting. Fly.io, Railway, a VPS with
Docker Compose — all of them provide those. The code reads `PORT`,
`DATABASE_URL` and `X-Forwarded-*`, which is the contract every one of them
offers. Everything Render-specific is in `render.yaml` and a handful of
environment variables. Moving hosts is a config change, not a rewrite.

The one number that must change per host is `WALLY_TRUST_PROXY_HOPS`; see the
table in `.env.production.example`.

---

## PENDING: cross-network verification

**This has not been done and cannot be done from here.** Two browser tabs on
one laptop prove nothing about the public internet: they share a NAT, a DNS
resolver, a TLS path and a clock. The procedure below is written to be run
verbatim the moment hosting exists.

### Before you start

You need a second person, or a second device on a *different* network — a
phone on cellular data with Wi-Fi switched off is enough, and is the better
test because it also crosses a carrier-grade NAT.

Set these once in your shell:

```sh
export API=https://voxels-api.onrender.com     # the real hostname Render assigned
export WEB=https://voxels-web.onrender.com     # the real static-site hostname
```

### 1. The service is actually reachable, and is actually TLS

```sh
curl -sS -o /dev/null -w '%{http_code} %{scheme} %{remote_ip}\n' "$API/api/live"
```

Expect `200 https <a public IP>`. A private address (`10.`, `192.168.`,
`172.16–31.`) means you are still talking to the laptop.

### 2. The database survived the deploy, and readiness says so

```sh
curl -sS "$API/api/ready" | python3 -m json.tool
```

Expect `"status": "ready"` and a `database:game` check with `"ok": true` whose
detail says `postgres`. If it says `sqlite`, `WALLY_DB_DRIVER` did not take and
every account will be deleted on the next redeploy — stop and fix that first.

### 3. `ws://` is refused and `wss://` works

```sh
curl -sS -o /dev/null -w '%{http_code}\n' "http://${API#https://}/api/live"
```

Expect `301`. Render redirects plaintext, and most WebSocket clients will not
follow the redirect — which is why the client derives `wss://` from an
`https:` page origin rather than being told the scheme.

### 4. A stranger's origin is turned away

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example.com' "$API/api/live"
```

Expect `403` with `{"error":"origin_not_allowed"}`. Then confirm the real
origin is accepted:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -H "Origin: $WEB" "$API/api/live"
```

Expect `200`.

### 5. The prepared suites, against the deployed host

Both of these run unchanged against a remote host:

```sh
API="$API" ORIGIN="$WEB" npm run verify:hardening
```

Expect all checks to pass. This covers origin rejection at the socket upgrade,
one-tab-per-character takeover, movement clamping, reconnect, the socket
upgrade rate limit, and the absence of anything financial in a broadcast.

`npm run verify:restart` is **not** valid against a deployed host — it starts
and signals its own server. The deployed equivalent is step 7.

### 6. Two people, two networks, one town

This is the part that has never been observed and is the whole point.

1. You open `$WEB`, sign in, and walk out of town.
2. The other person — **on a different network** — opens `$WEB` on their own
   device and signs in.
3. Confirm, out loud, that each of you can see the other's nameplate move in
   real time. Screenshot both screens.
4. Click the other player, send a challenge with a stake of 10, have them
   accept, and fight the duel to a result.
5. Both of you check that your gold moved by exactly the stake and in
   opposite directions.

Then, still with both of you connected:

6. The other person turns their Wi-Fi/data off for ten seconds and back on.
   Their client should reconnect on its own — the backoff is exponential with
   full jitter, capped at 30 seconds — and their character should resume where
   it was rather than back at the town gate.
7. Open the same character in a second tab on your own device. The first tab
   must show "Playing somewhere else" and stop moving; the second must have
   control. Click "Play here instead" in the first tab and confirm control
   comes back to it and the second tab surrenders it.

### 7. A deploy does not eat a duel

With both people connected and mid-duel, trigger a manual deploy (or "Restart
service") from the Render dashboard.

Expected: both clients show the reconnecting state rather than an error, the
duel is voided and **both stakes are returned** (check the journal), and both
clients are back in the world within roughly a minute — Render's cold start
plus the client's first retry. Nobody should have to reload the page.

### 8. Record what you saw

Write down, for each step, what actually happened — not what was expected.
Anything that did not happen is not verified.

---

## Things that are true and worth knowing before launch

- **One world process.** `numInstances` is 1 and must stay 1. Render's load
  balancer sends each WebSocket connection to a random instance, so a second
  instance is not more capacity, it is a second town behind the same URL.
  Capacity goes up by moving to a larger compute plan. The current declared
  capacity is 64 players and is published at `/api/health`.
- **Hunt kills are a validated claim, not a server simulation.** The server
  decides how many animals a hunt contains, which species each is and what it
  pays, and issues one single-use token per animal (`hunt_kill_tokens`). So
  the amount is authoritative, each reward is granted at most once, and the
  total per session is bounded before the hunt starts. What is *not* proven is
  that a fight happened: a client holding a valid token can claim it without
  fighting. Duels, by contrast, are simulated server-side. Both halves of that
  belong in any description of the game's economy.
- **Free Postgres deletes itself.** If you launch on the Free database to try
  it, put a reminder in a calendar for day 28. There are no backups to restore
  from.
- **Nothing secret is in this repository or in the bundle.** `npm run
  audit:bundle` proves the second half of that claim and should stay in CI.
