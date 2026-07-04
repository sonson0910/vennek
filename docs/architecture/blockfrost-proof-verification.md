# Blockfrost Proof Verification

Vennek's `/proof` command remains payload-only. It never signs, submits, or constructs Cardano transactions.

`/proof-verify` can optionally verify that an externally submitted Cardano transaction contains a `vennek.proof.v1` metadata payload by reading transaction metadata through Blockfrost.

## Environment

```bash
BLOCKFROST_PROJECT_ID=...
BLOCKFROST_NETWORK=mainnet # mainnet | preprod | preview
```

## Command

```text
/proof-verify <tx_hash> [expected_content_hash]
```

Behavior:

- validates transaction hash format;
- fetches `/txs/{hash}/metadata` from the configured Blockfrost network;
- searches `json_metadata` entries for `schema: "vennek.proof.v1"`;
- if `expected_content_hash` is provided, requires exact match;
- returns verified/failed status;
- does not use wallet keys, seed phrases, signing libraries, or transaction submission.

## Safety

This feature verifies metadata already submitted externally by a human. It is not custody, not signing, and not automatic transaction submission.

## Production Caveat

Mocked tests cover success, missing key, missing metadata, and hash mismatch. A real staging check requires a valid Blockfrost project ID and a testnet/mainnet transaction containing `vennek.proof.v1` metadata.
