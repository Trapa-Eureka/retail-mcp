# Security Policy

This is the vulnerability reporting procedure for `@shiz_son/retail-mcp` (a sell-through and inventory BI MCP server for multi-branch retail + reorder suggestion agent). It was written in response to `docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md` SEC-007 (TASKS T32).

## Supported Versions

The first public version is `0.1.0` (2026-09-04). During the 0.x stage, only the **most recent minor line** (currently `0.1.x`) and the latest commit on the `main` branch receive security patches. After `1.0.0`, this section will be updated to be based on the latest major.

| Version | Supported |
|---|---|
| `main` (latest unpublished) | ✅ |
| `0.1.x` (latest published line) | ✅ |
| Earlier 0.x lines | ❌ — upgrade to the latest line |

## How to Report a Vulnerability

**Do not report via a public GitHub issue** — the attack method would be exposed before a patch is available.

Instead, please use GitHub's private reporting channel:

**[Trapa-Eureka/retail-mcp → Security → Report a vulnerability](https://github.com/Trapa-Eureka/retail-mcp/security/advisories/new)**

Including the following in your report speeds up the response:

- Affected files/versions (commit hash if possible)
- Reproduction steps or a PoC
- Expected impact (e.g. information disclosure, warehouse write, arbitrary code execution)
- Any mitigation you know of

## Response Targets

This project is maintained by a single person — we cannot promise an enterprise security team's SLA, but we aim for the following:

- **Initial response**: within 5 business days of receiving the report
- **Severity assessment shared**: within 5 business days of the initial response
- **Critical/High severity**: patching starts as top priority as soon as confirmed, with a target of releasing a patch within 30 days
- **Patch disclosure**: disclosed via CHANGELOG and a GitHub Security Advisory at a time coordinated with the reporter (with credit if the reporter wishes)

## Known Security Design Boundaries of This Project

Before filing a formal report, please check the following first — these are already known and either intended behavior by design, or items where a response is in progress.

- **`explore_sql` (arbitrary SELECT query tool)**: disabled by default in production (`EXPLORE_SQL_ENABLED=false`). When enabling it, a dedicated DB role with restricted function execution privileges is strongly recommended, and on embedded PGlite (where role separation is impossible) it does not turn on at all unless `EXPLORE_SQL_ALLOW_PGLITE=true` is set explicitly — `docs/DESIGN.md` §12.4, `docs/005` SEC-001/002.
- **CSV/XLSX file size/row/cell-length limits**: see `src/adapters/fileLimits.ts` — for XLSX, a residual risk is documented where a zip bomb is already expanded in memory before the limit check, as in the shared-strings cache stage.
- **Snapshot CSV formula injection escape**: applies only to store name, product name, and SKU (`src/core/csvSafety.ts`) — if other free-text fields are added, the same escape must be applied.
- **CI security gates** (`.github/workflows/ci.yml`, TASKS T35): on every push/PR, it automates dependency audit (lockfile-based; new unapproved vulnerabilities are blocked fail-closed), committed-secret pattern scanning (the entire current tree + blobs newly introduced in **every commit** within the PR/push's `base..head` range — so a secret added and removed in an intermediate commit is caught too, second adversarial review SR2-SEC-003), SBOM (CycloneDX) generation, and an audit against the published tarball (`npm run verify:pack` — in PR CI it passes with a warning only when a report could not be obtained due to a registry outage, while in the actual publish path `prepublishOnly` nothing is published without a valid report) — see `src/adapters/auditLockfile.ts`/`src/core/secretScan.ts`. The workflow-wide `GITHUB_TOKEN` permission is pinned to the minimum (`contents: read`) (second adversarial review SR2-CI-001) — fork PR code does not inherit repository default permissions even if they are widened later. The external code CI runs is also pinned immutably (SR2-CI-002) — every Action is referenced by full commit SHA (tags as comments) rather than a movable `@v4` tag, and the Postgres service container by manifest digest, so even if an upstream tag is moved or compromised, CI for the same commit runs the same code. SHA updates are proposed as PRs by Dependabot (`.github/dependabot.yml`, monthly) and reviewed/merged by a human. These gates are also enforced by repository settings so they cannot be bypassed (SR2-CI-004, 2026-09-04) — the `main` branch ruleset blocks direct push, force push, and deletion, allows PRs only, requires all 7 CI checks above to pass before merging, and nobody is on the bypass list (administrators included). In an emergency, the only option is to temporarily disable the ruleset, and that action is recorded in the repository audit log.
- **Publish path** (`.github/workflows/release.yml`, T37): npm publishing happens only via a `v*` tag push, with `npm publish --provenance` on a GitHub-hosted runner — every published tarball is accompanied on npm by a Sigstore attestation that "this workflow built this from this commit of this repository", verifiable with `npm audit signatures`. Right before publishing, `prepublishOnly` re-runs the full checks + tarball-based audit (fail-closed). `id-token: write` is granted to that job only. An npm granular token was used as a repository secret only for the first publish (`0.1.0`); after that we switched to npm trusted publishing (OIDC — each workflow run exchanges the GitHub id-token for a short-lived npm token) and revoked both the secret and the token. In other words, this repository holds no long-lived credential that can publish to npm, and publishing is possible only when `release.yml` of `Trapa-Eureka/retail-mcp` runs in the `npm-publish` environment (human approval required).
- **Limits of the in-house secret scanner** (`src/core/secretScan.ts`, second adversarial review SR2-SEC-005): the scanner this repository's CI runs is not a general-purpose tool like gitleaks/truffleHog but a lightweight **pattern-based** check limited to the credentials this project actually handles — the four secrets in `.env.example` (`LOYVERSE_API_TOKEN` assignment, `DATABASE_URL` connection string with credentials, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`), npm/GitHub tokens and hard-coded Bearer headers in the CI/publish flow, Google API keys and service account JSON, AWS keys, and PEM private key blocks. **It does no entropy analysis**, so arbitrary-string secrets with no known prefix or variable-assignment form (e.g. a hex token pasted without a variable name) are not caught. This scanner is for the repository's CI only and is not included in the npm package (it does not run in users' environments). The reason no external scanner was added is that there are only a handful of patterns and they are pure functions that can be unit-tested locally — this decision will be revisited when a general-purpose scanner becomes necessary (contributions from other organizations, a sharp increase in secret types).
- Other in-progress items are tracked in `docs/004~009` (adversarial review results) and `docs/TASKS.md` T28~T37.

## Scope

- The code in this repository (`src/`, `migrations/`, `scripts/`) and the official distribution artifact (the npm package)
- Things this project does not directly manage (the Loyverse API itself, the Resend service itself, Postgres instances users configure themselves) are out of scope — please report to that service's security channel.
