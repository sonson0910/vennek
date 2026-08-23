# Demo Scenarios

## Scenario 1 — Proposal Summary

Command:

```text
/proposal <Catalyst proposal URL>
```

Expected:

- Human decision frame.
- Problem/request/impact/feasibility/risks/missing evidence.
- Citations list with snippets.
- No vote recommendation.

## Scenario 2 — Proposal Comparison

Command:

```text
/compare <proposal A URL or text> <proposal B URL or text>
```

Expected:

- Fixed rubric: impact, feasibility, budget/resources, lexical evidence signals, risk.
- Evidence signals are keyword coverage only, explicitly not evidence quality or a score.
- Citations from both items.
- Reminder that the human decides.

## Scenario 3 — DRep Rationale Draft

Command:

```text
/vote-draft <proposal URL or text> abstain
```

Expected:

- Uses only the human-selected stance.
- Includes caveats and citations.
- Does not choose support/oppose/abstain for the user.

## Scenario 4 — Source Audit

Command:

```text
/sources <proposal URL or text>
```

Expected:

- URL/snippet/timestamp.
- Explicit source-unavailable status if source failed.

## Scenario 5 — Proof Payload

Command:

```text
/proof Final rationale text with citation IDs
```

Expected:

- SHA-256 content hash.
- `vennek.proof.v1` metadata payload.
- No signing/submission/wallet connector.

## Scenario 6 — Blockfrost Proof Verification

Command:

```text
/proof-verify <tx_hash> <expected_content_hash>
```

Expected:

- Checks externally submitted transaction metadata through Blockfrost.
- Looks for `schema: "vennek.proof.v1"`.
- Requires a valid 64-hex SHA-256 expected content hash and checks an exact match.
- Does not sign, submit, or construct transactions.
