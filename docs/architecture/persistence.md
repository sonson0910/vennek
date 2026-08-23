# Persistence and Audit Logs

Vennek's MVP persistence is intentionally file-backed and opt-in. It is designed to provide a durable audit trail without adding database operations before the product proves pilot value.

## Enable Persistence

Set a runtime data directory:

```bash
VENNEK_DATA_DIR=/var/lib/vennek npx tsx apps/telegram-bot/src/main.ts --poll
```

For local CLI testing:

```bash
VENNEK_DATA_DIR=./data npx tsx apps/telegram-bot/src/main.ts /proposal https://projectcatalyst.io/...
```

## Directory Layout

```text
<VENNEK_DATA_DIR>/
  audit-logs/
    commands.jsonl
  source-cache/
    <document-id>-<hash>.json
  proof-receipts/
    <proof-id>.json
  watch-items/
    .gitkeep-ready directory for future P1 watch state
```

## Audit Log Policy

Command audit logs store:

- command name;
- ok/source status;
- SHA-256 hash of raw input;
- short redacted input preview;
- SHA-256 hash of output;
- short redacted output preview;
- citation IDs;
- warnings.

Directories are created with mode `0700`; files are written/chmodded to `0600`. Persistence is fail-open for command UX: if the store cannot be written, the command response still returns and Vennek logs a warning.

Default retention limits are a 10 MiB `commands.jsonl` audit file plus one `.1` backup, 500 source-cache files, and 500 proof-receipt files. An oversized audit entry is rejected before writing or rotating the audit files.

Pasted user text (`sourceType: user-provided` with a `user-provided:` URL) is hash-audited with redacted previews but is **not source-cached**. Public fetched sources are sanitized/clone-redacted before caching. The store never holds wallet keys, seed phrases, signing material, or custody data.

They do **not** store wallet keys, seed phrases, private keys, or automatic transaction material because those flows are forbidden by the product safety contract.

## Source Cache Policy

When a command returns `document`, `left`, or `right` data from a public fetched source, Vennek writes the normalized, sanitized/clone-redacted `ProposalDocument` into `source-cache/` with a content hash. User-provided pasted text is excluded from this cache.

## Proof Receipt Policy

`/proof` receipts are written under `proof-receipts/` only when persistence is enabled. The receipt remains payload-only; Vennek does not sign or submit transactions.

## Production Caveat

This file-backed store is suitable for MVP demos and supervised pilots. For high-availability production, migrate to SQLite/Postgres with retention policy, backups, and operational monitoring.
