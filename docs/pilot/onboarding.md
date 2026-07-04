# Vennek Pilot Onboarding

## Pilot Goal

Validate whether Vennek helps Catalyst reviewers and DReps read, compare, cite, and draft governance rationale faster without turning into a vote recommendation engine.

## Who Should Join

- Catalyst reviewers who regularly compare proposals.
- DReps or governance participants who publish rationale.
- Cardano community members who can review citation accuracy.

## Safety Contract

Vennek is draft analysis only:

- humans choose stance;
- Vennek does not vote;
- Vennek does not sign or submit transactions;
- every sourced answer must include citations or say source unavailable;
- humans verify final sources before using output publicly.

## Pilot Tasks

1. Run `/proposal <url_or_text>` on one proposal/action.
2. Run `/compare <item1> <item2>` on two related items.
3. Run `/vote-draft <id> <support|oppose|abstain>` using a stance you choose.
4. Run `/sources <id>` and inspect whether snippets support the claims.
5. Optionally run `/proof <text>` to generate a payload-only proof receipt.

## Metrics Collected

- Usefulness rating.
- Estimated time saved.
- Citation accuracy sample.
- Confusing or unsafe wording.
- Missing source/failure cases.
- Whether output changed your review workflow.
