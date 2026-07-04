# Vennek preprod proof fixture attempt — 2026-07-04

## Completed

- Re-opened Chrome Profile 1 in headless DevTools mode.
- Extracted and validated a working Blockfrost **preprod** project id without printing the key.
- Updated local staging env:
  - `BLOCKFROST_NETWORK=preprod`
  - `BLOCKFROST_PROJECT_ID=[redacted]`
- Verified Blockfrost preprod latest block through `npm run staging:smoke`.
- Generated a new preprod test wallet/address for the proof fixture.
- Added a submit helper:
  - `scripts/submit_preprod_proof_fixture.py`
- Generated fixture payload:
  - `samples/proof-fixtures/vennek-proof-fixture.json`

## Current fixture payload

Content hash:

```text
sha256:6d40b866557eda90c615a83ec3b9699dd71a3d7bbabfd9c0d2de83a143977ad2
```

Metadata payload label to submit: `674`

```json
{
  "schema": "vennek.proof.v1",
  "content_hash": "sha256:6d40b866557eda90c615a83ec3b9699dd71a3d7bbabfd9c0d2de83a143977ad2",
  "source_refs": ["https://t.me/cardano_claw_bot"],
  "created_at": "2026-07-04T00:00:00.000Z",
  "agent_version": "0.1.0",
  "report_id": "vennek-staging-proof-fixture"
}
```

## Verification

`npm run staging:smoke` now uses preprod and passes non-fixture checks:

```text
PASS VENNEK_DATA_DIR
PASS telegram.getMe
PASS blockfrost.latestBlock
network: preprod
SKIP blockfrost.proofFixture
```

Submit helper result:

```text
NO_UTXO: fund this preprod address first
```

## Blocker

The generated preprod address has no UTxO/funds yet. The public Cardano preprod faucet requires a valid faucet API key or captcha flow. The agent attempted direct faucet API calls and the browser faucet form; both returned:

```text
FaucetWebErrorInvalidApiKey
```

No transaction was submitted, and no tx hash was fabricated.

## To finish

Fund the generated address in `/home/son/.config/vennek/preprod-address.txt`, then run:

```bash
/home/son/anaconda3/envs/python_course/bin/python scripts/submit_preprod_proof_fixture.py
set -a; . /home/son/.config/vennek/vennek.env; set +a; npm run staging:smoke
```

Expected final state after funding/submission:

```text
PASS blockfrost.proofFixture
```
