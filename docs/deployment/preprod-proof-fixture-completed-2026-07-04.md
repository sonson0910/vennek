# Vennek preprod proof fixture completed — 2026-07-04

## Result

The Cardano preprod proof fixture is complete and verified.

## Faucet funding

Funded generated preprod fixture address via Cardano preprod faucet.

Faucet tx id:

```text
778c27f9f93159f5663e213d98213b8c036cb0da7c3aa63ec442809cfa882cd5
```

## Fixture transaction

Submitted a Cardano preprod metadata transaction containing `vennek.proof.v1` under metadata label `674`.

Fixture tx hash:

```text
31b8a4e207209320009ad2d216d1df088854867f548c5e2ef2d9f2fb04a2b74b
```

Expected content hash used by the integration test:

```text
6d40b866557eda90c615a83ec3b9699dd71a3d7bbabfd9c0d2de83a143977ad2
```

Note: the local proof payload uses `sha256:<hex>`, but Cardano metadata text values are limited to 64 bytes. The on-chain fixture stores the 64-byte hex digest only, and the staging env uses that same value for `BLOCKFROST_TEST_CONTENT_HASH`.

## Local env updated

`/home/son/.config/vennek/vennek.env` contains:

```text
BLOCKFROST_NETWORK=preprod
BLOCKFROST_PROJECT_ID=[redacted]
BLOCKFROST_TEST_TX_HASH=31b8a4e207209320009ad2d216d1df088854867f548c5e2ef2d9f2fb04a2b74b
BLOCKFROST_TEST_CONTENT_HASH=6d40b866557eda90c615a83ec3b9699dd71a3d7bbabfd9c0d2de83a143977ad2
```

## Verification

`npm run staging:smoke`:

```text
PASS VENNEK_DATA_DIR
PASS telegram.getMe
PASS blockfrost.latestBlock
PASS blockfrost.proofFixture
```

Targeted integration test:

```text
npm test -- tests/blockfrost.integration.test.ts --run
```

Result:

```text
1 test file passed
1 test passed
```

Additional gates:

```text
npm run typecheck: pass
npm run build: pass
```

## Runtime

Restarted `vennek-telegram.service` so the bot process picks up the updated preprod fixture env.

Service status:

```text
active
telegram_polling_started
```
