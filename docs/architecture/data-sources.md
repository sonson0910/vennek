# Data Sources

## Source Classes

- Catalyst proposal pages or snapshots.
- GovTool/governance action pages or snapshots.
- User-provided text, markdown, or URL fallback.

## MVP Source Strategy

The MVP includes deterministic offline fixtures under `samples/proposals` and a sample-mode validation script:

```bash
npm run validate:sources
```

This validates the `ProposalDocument` contract and citation requirement without depending on live website shape. The npm script writes `samples/proposals/validation-results.json`; running the script directly without `--write-report` prints JSON to stdout and avoids mutating the working tree.

## Live Pre-Submit Validation

Production pre-submit validation uses real operator-provided sources and never fabricates entries:

```bash
npm run validate:sources:live
npm run validate:sources:live -- --file path/to/sources.txt
```

By default the script reads `samples/proposals/live-sources.txt`. Add one real URL or pasted source text entry per line; blank lines and `#` comments are ignored. The live run resolves each entry through the same source normalization path used by commands, records pass/fail reasons, and fails unless at least 20 real entries are provided and at least 15 normalize with usable citations.

Current repository validation includes mixed live coverage: Catalyst proposal pages, GovTool/governance documentation pages, user-provided fallback text samples, and one expected SSRF-block failure sample to prove failures are recorded with reasons.

## Remote Fetch Safety

Remote source fetching is HTTPS-only and rejects credentials, private/loopback/link-local/multicast/reserved IPs after DNS resolution, unsupported content types, redirects, and bodies over 2 MiB. Local file reads are disabled by default and require an explicit trusted root.

## Failure Policy

If a live source fails to fetch or normalize, Vennek must record the failure and produce explicit source-unavailable status. It must not fabricate proposal content or citations.
