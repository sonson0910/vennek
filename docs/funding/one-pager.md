# Funding Narrative One-Pager

## Project

**Vennek — Open-source Cardano Governance Copilot for Catalyst Reviewers and DReps**

## One-Liner

Vennek helps Catalyst reviewers and DReps understand, compare, explain, and audit governance decisions through a source-grounded Telegram/OpenClaw-compatible copilot with optional human-submitted Cardano proof receipts.

## Why Now

Cardano governance is increasing the amount of information reviewers and DReps must process. Proposals, governance actions, rationale, and evidence are spread across multiple sources. Participants need faster workflows without sacrificing transparency or human accountability.

## Problem

Governance participants need to:

- read long proposals/actions quickly;
- compare evidence and risks consistently;
- draft transparent rationale;
- cite sources;
- preserve audit trails;
- avoid uncited AI summaries and unsafe automated voting.

## Solution

Vennek provides a repeatable workflow:

```text
source ingestion
→ cited proposal analysis
→ fixed-rubric comparison
→ human-selected vote rationale draft
→ source audit
→ optional proof payload / Blockfrost metadata verification
```

## Why Not Another Analytics Dashboard

Cardano analytics/trading is already crowded. Vennek focuses on governance workflow and public-good transparency, not charts, trading, or wallet-risk analytics.

## Safety

- No seed phrases.
- No private keys.
- No wallet connector.
- No auto-vote.
- No signing or transaction submission.
- No financial advice.
- Human chooses stance.
- Every sourced output cites sources or says source unavailable.

## Current Evidence

- Working TypeScript MVP.
- 46 tests passing.
- Build/typecheck/import verification passing.
- Mixed live source validation passing.
- Citation fixture eval passing.
- Telegram runtime hardening implemented.
- Blockfrost proof verification adapter mocked/tested.
- Pilot docs and runbook prepared.

## What Still Needs Pilot Proof

- Real reviewer/DRep usage.
- Time saved.
- Human-sampled citation accuracy.
- Real Telegram staging logs.
- Real Blockfrost verification against a known transaction.

## Pilot Success Target

- 8 recruited participants.
- 5 active users after two weeks.
- 50 proposal/action analyses.
- 10 human-reviewed vote drafts.
- >=80% usefulness.
- >=90% sampled citation accuracy.
- 0 custody/signing/vote recommendation incidents.
