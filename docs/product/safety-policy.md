# Safety Policy

Vennek is decision support. It is not a voter, signer, wallet, exchange, or financial advisor.

## Required Output Contract

- Include `Draft analysis; human decides.`
- Include citations for sourced commands, or explicitly say source unavailable.
- Preserve caveats and missing evidence.
- Do not choose a vote stance.
- `/vote-draft` must receive `support`, `oppose`, or `abstain` from the human.
- Evidence signals report lexical keyword coverage only; they are not evidence quality or a score.
- Source-stated claims are rendered as quoted/sourced text with claim-level citations.
- Generated first-person rationale uses fixed, source-neutral wording and does not copy source directives.

## Forbidden MVP Behavior

- No seed phrases or key handling.
- No wallet connectors.
- No automatic transaction submission.
- No automatic voting.
- No financial or trading advice.
- No fabricated sources.

## Proof Receipts

`/proof` only hashes user-provided text and emits metadata payload. Humans submit externally if they choose. External transaction verification is a separate integration boundary.

`/proof-verify` requires both `<tx_hash>` and `<expected_content_hash>`; the expected value is a 64-hex SHA-256 hash. Verification only reads externally submitted metadata and never signs, submits, or constructs a transaction.

## Dev-only Fixture Exception

`scripts/submit_preprod_proof_fixture.py` is a developer-only preprod fixture utility used to create the staging proof transaction. It is not part of the Telegram/runtime product, must not run in production services, and must not be used with mainnet funds or user wallet material. Product commands remain no-custody and verification-only.
