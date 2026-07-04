# Safety Policy

Vennek is decision support. It is not a voter, signer, wallet, exchange, or financial advisor.

## Required Output Contract

- Include `Draft analysis; human decides.`
- Include citations for sourced commands, or explicitly say source unavailable.
- Preserve caveats and missing evidence.
- Do not choose a vote stance.
- `/vote-draft` must receive `support`, `oppose`, or `abstain` from the human.

## Forbidden MVP Behavior

- No seed phrases or key handling.
- No wallet connectors.
- No automatic transaction submission.
- No automatic voting.
- No financial or trading advice.
- No fabricated sources.

## Proof Receipts

`/proof` only hashes user-provided text and emits metadata payload. Humans submit externally if they choose. External transaction verification is a separate integration boundary.
