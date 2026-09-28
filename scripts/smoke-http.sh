#!/usr/bin/env bash
# Live HTTP smoke test. Boots the API on a spare port against throwaway databases,
# walks the account/hunt/withdrawal surface as a guest, then shuts it down.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=8799
export PORT
export WALLY_DB_PATH=data/smoke.db
export WALLY_FINANCE_DB_PATH=data/smoke-finance.db
rm -f data/smoke.db* data/smoke-finance.db*

npx tsx src/server/index.ts > /tmp/server-smoke.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  curl -sf "localhost:$PORT/api/live" > /dev/null && break
  sleep 0.5
done

api() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }
jpick() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

echo "--- guest session ---"
GUEST_KEY=$(openssl rand -hex 32)
TOKEN=$(curl -s -X POST "localhost:$PORT/api/pvp/guest" -H 'Content-Type: application/json' \
  -d "{\"guestKey\":\"$GUEST_KEY\"}" | jpick 'd["token"]')
echo "token acquired: ${#TOKEN} chars"

echo "--- GET /api/account ---"
api "localhost:$PORT/api/account" | jpick 'json.dumps({k:d[k] for k in ("userId","kind","gold") if k in d})'

echo "--- GET /api/gold ---"
api "localhost:$PORT/api/gold" | jpick 'json.dumps({k:d[k] for k in ("available","reserved","redeemable")})+" | "+d["eligibility"]["rule"]'

echo "--- POST /api/hunt/session ---"
HUNT=$(api -X POST "localhost:$PORT/api/hunt/session" -H 'Content-Type: application/json' -d '{"region":"wildwood","level":5}')
echo "$HUNT" | jpick '"roster of "+str(d["rosterSize"])+", first token "+json.dumps(d["tokens"][0])'
CLAIM=$(echo "$HUNT" | jpick 'json.dumps({"huntId":d["huntId"],"tokenId":d["tokens"][0]["tokenId"]})')

echo "--- POST /api/hunt/claim (first) ---"
api -X POST "localhost:$PORT/api/hunt/claim" -H 'Content-Type: application/json' -d "$CLAIM"; echo
echo "--- POST /api/hunt/claim (same token again) ---"
api -o /tmp/claim2.json -w 'http %{http_code} ' -X POST "localhost:$PORT/api/hunt/claim" -H 'Content-Type: application/json' -d "$CLAIM"
cat /tmp/claim2.json; echo

echo "--- GET /api/gold after the kill ---"
api "localhost:$PORT/api/gold" | jpick 'json.dumps({k:d[k] for k in ("available","redeemable")})'

echo "--- POST /api/withdrawals/quote (nothing configured) ---"
api -o /tmp/wd.json -w 'http %{http_code}\n' -X POST "localhost:$PORT/api/withdrawals/quote" \
  -H 'Content-Type: application/json' -d '{"goldAmount":"100"}'
python3 -c 'import json;d=json.load(open("/tmp/wd.json"));print(d["error"]);print("missing:",[m["key"] for m in d["missing"]]);print("signer available:",d["signer"]["available"])'

echo "--- GET /api/ledger/conservation ---"
api "localhost:$PORT/api/ledger/conservation" | jpick '"balances="+str(d["balances"])+" balanceSum="+d["balanceSum"]+" entrySum="+d["entrySum"]'

echo "--- another account cannot read this one's jobs ---"
OTHER=$(curl -s -X POST "localhost:$PORT/api/pvp/guest" -H 'Content-Type: application/json' \
  -d "{\"guestKey\":\"$(openssl rand -hex 32)\"}" | jpick 'd["token"]')
# `ownerUserId` in the body is the spoof attempt: the route must ignore it and take
# the owner from the session, which is what the 404 below demonstrates.
JOB=$(api -X POST "localhost:$PORT/api/jobs" -H 'Content-Type: application/json' \
  -d '{"kind":"ledger.audit","idempotencyKey":"smoke-audit-1","ownerUserId":"u_somebody_else"}' | jpick 'd["job"]["jobId"]')
echo "job $JOB created by the first account"
api -o /dev/null -w 'its owner can read it: http %{http_code}\n' "localhost:$PORT/api/jobs/$JOB"
curl -s -o /dev/null -w 'the other account reading it: http %{http_code}\n' -H "Authorization: Bearer $OTHER" "localhost:$PORT/api/jobs/$JOB"
curl -s -H "Authorization: Bearer $OTHER" "localhost:$PORT/api/jobs" | jpick '"the other account sees "+str(len(d["jobs"]))+" jobs"'

echo "--- the same idempotency key does not create a second job ---"
api -X POST "localhost:$PORT/api/jobs" -H 'Content-Type: application/json' \
  -d '{"kind":"ledger.audit","idempotencyKey":"smoke-audit-1"}' | jpick '"created="+str(d["created"])+" jobId="+d["job"]["jobId"]'

echo "--- a financial job kind is not reachable from a client ---"
api -o /tmp/fin.json -w 'http %{http_code} ' -X POST "localhost:$PORT/api/jobs" \
  -H 'Content-Type: application/json' -d '{"kind":"withdrawal.reconcile","idempotencyKey":"smoke-fin-1"}'
cat /tmp/fin.json; echo

echo "--- no session at all ---"
curl -s -o /dev/null -w 'unauthenticated /api/gold: http %{http_code}\n' "localhost:$PORT/api/gold"
curl -s -o /dev/null -w 'unauthenticated /api/hunt/claim: http %{http_code}\n' -X POST "localhost:$PORT/api/hunt/claim" \
  -H 'Content-Type: application/json' -d '{"huntId":"h_00000000000000000000000000000000","tokenId":"hk_00000000000000000000000000000000"}'

echo "--- the job is queued and the API has not run it ---"
api "localhost:$PORT/api/jobs/$JOB" | jpick 'd["job"]["status"]'

echo "--- the worker picks it up ---"
npx tsx src/server/jobs/worker.ts > /tmp/worker-smoke.log 2>&1 &
WORKER=$!
sleep 4
kill $WORKER 2>/dev/null
grep -E 'schema|handlers|custody' /tmp/worker-smoke.log
api "localhost:$PORT/api/jobs/$JOB" | jpick '"status="+d["job"]["status"]+" result="+json.dumps(d["job"]["result"])'
