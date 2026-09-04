# 009 — Documentation Consistency Review and Fix-Order Verdict

- Review date: 2026-09-03
- Question: Fix the existing Markdown right now, or implement per the new review documents first and then fix the related documents?
- Verdict: **Do not pick just one of the two. The safest is a 3-stage order: normative documents first → code/tests → operational documents last.**
- Status: **Stages 1~3 RESOLVED** — Stage 1 (normative documents) was reflected in `docs/TASKS.md` T28 (PR #39): SPEC §18/DESIGN §12/TESTING §8/TASKS (T0~T7 corrections + T28~T37) (2026-09-03). Stage 2 (code + tests) was completed as T29~T35 (PR #40~#47). Stage 3 (operational document sync) proceeds in T36 — README/CLAUDE/SECURITY/CHANGELOG sync + recording the resolution basis for each 004~008 finding (`docs/010`). Stage 4 (tarball re-review) proceeds in T37. DOC-001/003/005 were resolved in T28, **DOC-002 was resolved cumulatively across T28~T35 as each section of DESIGN §12 was added** (the 6th line of 009 previously said "DOC-002~004 in T36", which was an update missed after T28 completed — this line is now the correction), and DOC-004 is resolved in T36 by the README "Installation" section.

## Inconsistencies confirmed in the current documents

### DOC-001 — T0~T7 in TASKS are TODO, yet README says T0~T11 are complete

- Severity: **High**
- Basis: T0~T7 at the top of `docs/TASKS.md` are in TODO/unchecked state, but the README status records all of T0~T11 as complete on 2026-09-02. The actual git history and implementation files also point to T0~T7 being complete.
- Impact: The current work status and dependency graph cannot be trusted, and an automated agent could redo completed work.

### DOC-002 — v0.1 rules in CLAUDE/DESIGN forbid or omit the current v0.2 implementation

- Severity: **High**
- Basis:
  - CLAUDE only says "v0.1 data source is Loyverse only" and "there is no free-form SQL in v0.1", and does not sufficiently reflect the current CSV/PGlite default and the completed `explore_sql` policy.
  - DESIGN's title, architecture, directories, and tool count are centered on v0.1/6 tools, and there are no formal design sections for CSV/Excel, SCM, pack size, and explore_sql.
  - Most implementation decisions accumulated only in the latter part of SPEC and in the TASKS completion logs.
- Impact: This conflicts with the project's own rule that CLAUDE is the starting document and DESIGN is the source of truth for implementation. A subsequent editor could revert the latest features to match outdated rules.

### DOC-003 — MCP tool count and permission descriptions differ across documents

- Severity: **Medium**
- Basis: DESIGN/the initial SPEC say 6 tools; the default server adds conditional `sync_now` and conditional `explore_sql` to 5 query tools. Parts of the README describe it as 5 query tools.
- Impact: Installers find it hard to predict the actually exposed tools and the required permissions.

### DOC-004 — No npm distribution usage or support contract at all

- Severity: **Critical**
- Basis: The README only provides commands based on a repository checkout and does not explain package install, bin, scope, supported Node/OS, data location, upgrade, or license.
- Impact: Even if published to npm, consumers cannot install or run it.

### DOC-005 — Lifecycle of completed adversarial review documents is undefined

- Severity: **Medium**
- Basis: 001~003 retain their failure verdicts from that time, but several items were resolved by follow-up fixes. There is no record of whether they were resolved, the resolving commit, or re-review status.
- Impact: Current defects and historical defects are mixed together, confusing the release verdict.

## Recommended fix order

### Stage 1 — Change only the normative documents before implementing

The documents to change first are those that decide "how it should behave".

1. `SPEC.md`: Approve the target users of the npm distribution, the public/private scope, the CLI/MCP public contract, the data retention/SCM policy, and whether `explore_sql` is allowed.
2. `DESIGN.md`: Make the build/bin structure, authoritative snapshot replacement, file idempotency, SQL isolation, and atomic snapshot write into implementation contracts.
3. `TESTING.md`: Add 008's release gate and attack regression tests as mandatory criteria.
4. `TASKS.md`: Correct the actual status of the existing T0~T27, then number the new fix tasks in dependency order.
5. `CLAUDE.md`: After the decisions above are finalized, briefly reflect only the latest guardrails and the current v0.2 structure.

At this stage, do not expand the README's "complete/usable" wording. Only a release-blocked warning may be shown first.

### Stage 2 — Fix code and tests based on the new review documents

- Priority P0: REL-001~004, SEC-001~002, DATA-001~004, QA-001
- Priority P1: dependency/file security, SCM accuracy, Postgres component test, operational cleanup
- For each item, add a failing test first, and after the fix record the resolving commit and re-review result in the corresponding review document.
- Also add per-item `OPEN/RESOLVED/SUPERSEDED` status to the existing 001~003 to restore their currency.

### Stage 3 — After implementation is complete, change the explanatory/operational documents to match the actual results

Finally, write the README, quickstart, install/upgrade/uninstall, SECURITY, and CHANGELOG to match the actual tarball and command output. Writing the final usage as definitive sentences before fixing the code makes it likely to drift again during implementation.

## Conclusion

"Fix all existing md first" risks fixing an npm product contract that has not yet been decided as if it were fact. Conversely, "fix the code first and documents later" breaks this project's documentation-first principle and lets the implementer decide security/data policy arbitrarily.

Therefore it is best to adopt the following order as the release rule:

```text
Freeze the review record (004~009)
→ Approve decisions and completion criteria in SPEC/DESIGN/TESTING/TASKS
→ Fix code + failing tests
→ Sync README/CLAUDE/operational documents to the actual artifacts
→ Re-review npm pack/fresh-install/release gate
→ Approve publish
```

## Documentation re-review completion criteria

- [ ] T0~T27 status matches git history and verification results
- [ ] DESIGN includes the actual v0.2 structure and conditional tools
- [ ] CLAUDE guardrails do not conflict with the latest features
- [ ] README commands reproduce as-is in a clean tarball install environment
- [ ] Current status and resolution basis recorded for each finding in 001~009
- [ ] version/changelog/tag/package metadata match at release time
