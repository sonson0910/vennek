# Architecture Overview

```text
Telegram/OpenClaw user command
  -> apps/telegram-bot router
  -> cardano-governance-skills command
  -> document store/adapters
  -> shared citation/hash contracts
  -> safety output guard
  -> formatted response
```

## Packages

- `packages/shared`: TypeScript contracts, citations, hashing.
- `packages/cardano-governance-skills`: source adapters, document store, commands, safety guards.
- `apps/telegram-bot`: deterministic command router and Telegram-safe formatter.
- `scripts`: source validation and demo runner.

## Deterministic Demo Path

`npm run demo` routes sample commands through the same router used by the Telegram skeleton. It does not require secrets, network, or a Cardano node.
