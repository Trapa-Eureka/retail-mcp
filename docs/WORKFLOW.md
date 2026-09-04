# WORKFLOW — the AI-native rules for running this repo

Basis: Clare Liguori (AWS), "From AI-Assisted to AI-Native: Building a Frontier Development Team"
(https://youtu.be/Ry0WHNxDbYA · AWS blog: https://aws.amazon.com/blogs/machine-learning/how-frontier-teams-are-reinventing-ai-native-development/)
The operating principles are identical to sheet_mcp's WORKFLOW. Here we record only a summary of the shared rules + **retail-mcp specifics**.

## 0. Role definition (the three frontier behaviors)

| Behavior | In this repo |
|---|---|
| Hands-off Coding (1~2%) | Jin only edits, reviews and approves SPEC/DESIGN. Implementation is done by agents |
| Infrequent Interaction | Machine-judged completion criteria per task → run to completion with no intervention during the session |
| Minimized Idle Time | After T1, lanes A~D run in parallel via git worktree. **Cross-repo parallelism** with sheet_mcp is also possible (they are independent) |

## 1. Five habits → rules (shared summary)

1. **Agent Context** — tribal knowledge exists only in CLAUDE.md/docs. Biweekly pruning + log.
2. **Slow Down to Speed Up** — invest in tools, types, schemas and error messages in T0~T1. Strict TS is the cheapest feedback loop.
3. **Feed, Don't Babysit** — assignment is the TASKS template, once. Self-verification = `npm run check` + the specified tests.
   ```bash
   git worktree add ../retail-mcp-t5 -b t5 && cd ../retail-mcp-t5 && claude
   ```
4. **Explicit Intent** — document diff before code. A metric formula change must always update SPEC §2 + DESIGN §3 together first, then be turned into a task.
5. **Shift Left** — local deterministic mocks: POS=fixtures, DB=**PGlite**, send/LLM=mocks. Live dependencies cannot enter the gate.

## 2. retail-mcp specifics

- **The formulas are the product**: for the metrics golden cases (TESTING §3), the hand-calculated values are the truth. If an agent makes a change in the direction of "fitting the test to the formula", it is rejected in review — the direction of a fix is always code → documented formula.
- **LLM boundary watch**: during review, check that no code lets Summarizer output flow into logic or numbers (CLAUDE.md guardrail 3).
- **Consistency of the two entry points**: the test that the MCP tool and the agent report agree numerically (TESTING §4) is the front line of regression — do not delete or weaken it.

## 3. Daily operating routine

1. Check tasks ready to start → assign a worktree per lane (can be mixed with sheet_mcp tasks)
2. Do not intervene during execution — use that time to refine the v0.2 docs or review
3. Completion report → re-run `npm run check` → review the diff → merge → update status
4. Biweekly: prune CLAUDE.md, tidy TASKS

## 4. Limits of autonomy (what humans hold)

- Switching to `SEND_MODE=live` and the first live send (`--confirm`)
- Running `npm run migrate` against a production `DATABASE_URL`
- Approving changes to metric formulas and defaults (lead time, target cover, etc.)
- Selecting pilot stores and managing the Loyverse token and secrets

## 5. Document consistency gate

Before starting a task, the assigned agent cross-checks not only the TASK itself but also the linked SPEC, DESIGN and TESTING sections. The changes below are not complete when only one file is fixed.

| Change | Documents to update together |
|---|---|
| Metric formulas, defaults, period boundaries | SPEC §2/§9, DESIGN §3/§11, TESTING golden cases |
| DB schema, sync cursor | DESIGN §2/§5/§11, the corresponding completion criteria in TASKS, migration tests |
| MCP input, output, permissions | DESIGN §6/§11, TESTING MCP and security checklists, README operations guide |
| Agent send and log status | DESIGN §7/§11, TESTING agent checklist, CLAUDE guardrails |

The review order is `document diff → migration/API contract → pure core → adapters and entry points → test results`. The completion report separately lists the commands run, pass/fail counts, and manual verifications that could not be run. Dates, statuses and task-completion marks in documents are updated only when the actual code and verification results agree.

## 6. Operational change checks

- Before a production DB migration, a human confirms the backup/recovery procedure and the target DB.
- Before a live send, check the dry-run output, recipients, sender domain, last sync time, and the send history for the same `run_id`.
- During an outage, keep the last successful data queryable but do not remove the stale warning. Retry only after confirming idempotency.
- If a secret is exposed in a diff, log or test fixture, immediately revoke and reissue that secret and escalate commit-history cleanup to a human.
