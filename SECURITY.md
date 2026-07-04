# Security Policy

Vennek is a governance decision-support MVP. It must remain no-custody: no seed phrases, no wallet connectors, no runtime signing, no auto-voting, and no financial/trading advice.

## Supported Versions

| Version | Supported |
|---|---|
| `main` | Security fixes accepted for the current pilot branch |

## Reporting a Vulnerability

This repository is currently private/pilot-stage. Report vulnerabilities to the repository owner through the private GitHub repo or the configured pilot contact channel.

Please include:

- affected command or file path;
- reproduction steps;
- expected vs actual behavior;
- whether secrets, wallet material, vote intent, citations, or source integrity are affected.

Do **not** include real secrets, seed phrases, private keys, bot tokens, Blockfrost project IDs, or wallet mnemonics in reports. Replace them with `[redacted]`.

## Response Targets

| Severity | Target response |
|---|---|
| Critical: secret leak, key custody, auto-sign/vote path | Stop affected runtime immediately, rotate secrets, patch before pilot use resumes |
| High: SSRF, auth bypass, unsafe source fabrication | Patch before public demo or pilot expansion |
| Medium: dependency CVE, misleading docs, weak logging redaction | Patch in next maintenance release |
| Low: hardening/docs | Track and batch |

## Secret Rotation SOP

If any token or key is exposed:

1. Revoke/rotate the exposed credential in its provider.
2. Remove the value from local logs/history if possible.
3. Search the repo and CI logs for the exposed value without printing it publicly.
4. Re-run tests and staging smoke with the rotated credential.
5. Record only `[redacted]` in reports.

## Security Checks Before Release

Run:

```bash
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run health
npm run validate:sources
npm run eval:citations
npm audit --audit-level=moderate
git diff --check
```

For staging releases, also run `npm run staging:smoke` with the staging env loaded.
