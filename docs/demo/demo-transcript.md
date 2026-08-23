# Demo Transcript

This transcript is the target demo flow for a Telegram or CLI recording. Replace sample IDs with real Catalyst/GovTool URLs during staging.

## 1. Proposal Summary

User:

```text
/proposal <Catalyst proposal URL>
```

Vennek should return:

- `Draft analysis; human decides.`
- Problem / requested action / impact / feasibility / risks / missing evidence.
- Citation anchors and snippets.
- No vote recommendation.

## 2. Compare Two Items

User:

```text
/compare <proposal A> <proposal B>
```

Vennek should show:

- Impact comparison.
- Feasibility comparison.
- Budget/resources comparison.
- Lexical evidence signals showing keyword coverage only, not evidence quality or a score.
- Risk comparison.
- Citations from both items.

## 3. Human-Selected Vote Draft

User:

```text
/vote-draft <proposal URL> abstain
```

Vennek should draft wording for `abstain` only. It must not choose stance for the user.

## 4. Source Audit

User:

```text
/sources <proposal URL>
```

Vennek should list URL, snippets, retrieval time, and source status.

## 5. Proof Payload

User:

```text
/proof Final rationale text with citation IDs
```

Vennek should create `vennek.proof.v1` metadata payload and clearly say it does not sign or submit transactions.

## 6. Blockfrost Verification

User:

```text
/proof-verify <tx_hash> <expected_content_hash>
```

Vennek should verify externally submitted metadata through Blockfrost and return verified/failed status.

## Demo Success Criteria

- Viewer understands the product in under 2 minutes.
- Each source-stated claim has a claim-level citation when a matching provenance span exists; otherwise it is marked `[source unavailable]`.
- Safety boundaries are explicit.
- The reviewer/DRep workflow feels faster than manual reading.
