# retail-mcp

An **inventory alert tool** for retailers that run multiple stores. Put the inventory files (CSV/Excel) exported from your stores into a folder, and it works out which products are about to run out and **lets you know by email.** Developers can also query the same data in natural language from an MCP client such as Claude Code.

- All number crunching (sell-through, inventory days of cover, reorder quantities) is done by deterministic code. The LLM only writes summary sentences.
- By default, data is stored only on your own computer (embedded DB). No account needs to be created.
- No real email ever goes out until a person explicitly turns it on (the default is preview).

---

## General Users — 5-Minute Start

This is the simplest path: watch one branch's inventory file and receive low-stock alert emails. No programming knowledge is required — just type the commands below as-is into a terminal (e.g. the "Terminal" app on macOS).

### Prerequisites

- **Node.js 20 or later** — install the LTS version from https://nodejs.org. To verify the installation, run `node -v` in the terminal.
- **macOS or Linux**. Windows has not been verified yet (it may work, but it is not a supported target).
- A **CSV or Excel file** containing your store's inventory (an example file showing the format is provided in step 3).
- (Only if you want to actually receive emails) a **Resend account** — https://resend.com; the free plan is sufficient. Explained in step 5.

### 1. Install

```bash
npm install -g @shiz_son/retail-mcp
```

Five commands are installed. This section uses only the first two.

| Command | What it does |
|---|---|
| `retail-mcp-onboard` | Answer a few questions and it creates the config file (`.env`) and an example inventory file |
| `retail-mcp-scan` | Reads the inventory file, determines low stock, and sends an email according to your settings |
| `retail-mcp` | MCP server (for developers — see "Query from Claude Code" below) |
| `retail-mcp-reorder` | Reorder suggestions via Loyverse POS integration (a path currently on hold — see the developer section) |
| `retail-mcp-migrate` | DB preparation command needed only when using an external Postgres (see the developer section) |

### 2. Configure (Onboarding)

**This tool creates its data and settings relative to "the folder you run the command in."** So first create a dedicated folder and run inside it. Every subsequent command (including automated runs) must also run in the same folder to see the same data.

```bash
mkdir -p ~/retail-mcp && cd ~/retail-mcp
retail-mcp-onboard
```

The questions come in this order.

1. **Mode** — enter `branch` (a single branch). For `consolidated`, which combines multiple branches, see "Consolidating Multiple Branches" below.
2. **DB connection string** — just press Enter (leave empty). The embedded DB on your own computer is then used.
3. **Store or branch name** — how this store should appear in alerts, e.g. `Downtown Store`. It is written into the `store` column of the example file. Store and product names are never fixed in the tool: every row of your inventory file carries its own `store` and `product` values, so a single file can hold several stores.
4. **Folder to watch** — the folder where you will put inventory files. Example: `~/retail-mcp/watch`. It is created if it does not exist.
5. **Snapshot folder** — the folder where the tool writes its result files. It must be a **different** folder from the watch folder. Example: `~/retail-mcp/snapshot`.
6. **Default low-stock threshold** — products with no sales history are flagged when their stock is at or below this quantity. If unsure, press Enter (default 5).
7. **Email to receive alerts** — your own address.
8. **Resend API key (optional)** — you can skip this with Enter for now (preview only). You fill it in at step 5.

When finished, `.env` (settings, readable only by you) is created in the current folder and `template-example.csv` (an example inventory file) in the watch folder.

### 3. Fill In the Inventory File

Open `template-example.csv` in the watch folder and you will see these columns.

| Column | Required | Meaning |
|---|---|---|
| `store` | Required | Store name, exactly as you want it shown in alerts. The example file uses the name you gave in onboarding |
| `product` | Required | Human-readable product name |
| `sku` | Required | Unique product code (always the same value for the same product) |
| `stock_qty` | Required | Current stock |
| `sales_qty` · `period_start` · `period_end` | Optional | If all three are given, "average daily sales" is calculated and the decision is made on **how many days the stock lasts** |
| `low_stock_threshold` | Optional | Per-product threshold (falls back to the default from step 2 if absent) |
| `pack_size` | Optional | Units per pack/box; when given, the suggested order quantity is rounded up to a whole number of packs |

Fill in your actual inventory in this format (open in Excel, edit, and save as CSV/XLSX), or take a file exported from your POS or ERP, match the column names, and put it in the watch folder. If the folder contains several files, the **most recently modified file** is read.

### 4. Run a Preview

```bash
cd ~/retail-mcp
retail-mcp-scan
```

It reads the file and shows the list of low-stock products and the reason (e.g. "stockout risk — days of cover 2.5, suggested 40") on screen. **No email is sent at this step** (default `SEND_MODE=dry_run`). If the file format is wrong, it tells you which column is the problem, so fix it and run again.

### 5. Turn On Email Sending

Emails go out through a sending service called Resend. Steps:

1. Sign up at https://resend.com → issue a key under **API Keys** (starts with `re_`). Treat this key like a password.
2. Decide the **sender address**. Resend requires you to verify a domain you own (by adding DNS records) before you can send from an address on that domain to anyone. If you have no domain, you can use the test sender address Resend provides to send **only to the email you signed up with** (see "Send test emails" in the Resend docs). For a single branch where you receive the emails yourself, this is enough.
3. Put it into the settings — either:
   - Run `retail-mcp-onboard` again, enter the key at question 8, then enter the sender address (existing settings are preserved). Or
   - Open `.env` in a text editor and fill in the `RESEND_API_KEY=` and `MAIL_FROM=` lines.
4. Change `SEND_MODE=dry_run` in `.env` to **`SEND_MODE=live`**.
5. **Run it manually the first time** to confirm the email actually arrives:

```bash
retail-mcp-scan --confirm
```

Without `--confirm`, nothing is sent even when `SEND_MODE=live` (a double lock against mistakes). Once the email arrives, go to step 6.

### 6. Run Automatically Every Day

Register one line in cron on macOS/Linux (`crontab -e` opens an editor). An example that runs every morning at 7:

```bash
0 7 * * * cd ~/retail-mcp && retail-mcp-scan --confirm >> ~/retail-mcp/scan.log 2>&1
```

- `cd ~/retail-mcp` matters — it must run in the folder set up in step 2 to use the same settings and data.
- If the file has not changed, the same alert is not sent again. However, even when the file stays the same, **one alert per day** is guaranteed so that you can tell when it has "silently stopped".
- Running it more often (e.g. hourly) does not increase the number of emails, because of the rule above.
- When a run finishes it returns exit code `0`; if it stops due to an unhandled error, `1`. The log file (`scan.log`) contains, alongside the human-readable lines, one JSON line (`{"event":"folder_scan_completed", ...}`) that other tools can read.

### Where Data and Settings Live

- Settings: `.env` in the run folder (permission 0600, readable only by you). It contains your email API key, so do not share or commit it.
- Data: `.retail-mcp/data/` in the run folder (embedded DB). To **back up**, copy this whole folder while the tool is not running. To restore, copy it back.
- Snapshots: the latest inventory snapshot CSV is refreshed on every scan in the snapshot folder chosen in step 2 (used for consolidating multiple branches).
- Deleted products: products and stores that disappear from the inventory file are not deleted from the DB; they are only marked "inactive". They are automatically revived when they appear in the file again.

### Troubleshooting

- **"… .lock is already in use by process …"** — two instances of the tool are running at the same time in the same folder. Wait for one to finish. If it keeps appearing even though the process has clearly died, confirm that retail-mcp is not running on any computer, then **only delete** the `.lock` file named in the message (do not edit or replace its contents).
- **"no inventory file found (.csv/.xlsx)"** — check that there is a `.csv`/`.xlsx` file in the watch folder and that the folder path matches `CSV_WATCH_DIR` in `.env`.
- **The email ends as "unknown whether it was sent (unknown)"** — the network dropped mid-response. Check in the Resend dashboard whether it actually went out; if not, re-run with the `run_id` value from the log passed as-is: `retail-mcp-scan --confirm --run-id=<that value>`. Resend prevents duplicate sends for the same run_id, but only **within 23 hours**. After that, the tool refuses and tells you to start a new run.
- **Upgrade**: `npm install -g @shiz_son/retail-mcp@latest`. Your data is kept as-is.
- **Uninstall**: `npm uninstall -g @shiz_son/retail-mcp`. Settings (`.env`) and data (`.retail-mcp/`) remain, so delete the folder yourself if you no longer need them.

### (Optional) Consolidating Multiple Branches — HQ Mode

Once each branch runs the procedure above, a standard-format inventory snapshot appears in its snapshot folder. Collect those files into one folder (any method you already use — shared-drive sync, saving email attachments, etc.) and HQ can query them in consolidated form.

```bash
mkdir -p ~/retail-mcp-hq && cd ~/retail-mcp-hq
retail-mcp-onboard        # enter consolidated for the mode and the collection folder path
retail-mcp-scan           # loads the branch snapshots in the collection folder per branch (an error in one branch's file does not affect the others)
```

HQ mode does not send alert emails; it only collects data. Query it via "Query from Claude Code" below.

### (Optional) Receipts and Reconciliation

If you manage orders and receipts in Google Sheets or similar, download that sheet as CSV and put it in the `SCM_RECEIPTS_DIR` folder from `.env`. The next scan compares "expected inventory based on the receipts ledger" against actual inventory and, if there is a discrepancy, includes it in the same alert email. The detailed format is in `docs/SPEC.md` §16.

---

## Query in Natural Language from Claude Code (MCP)

The installed `retail-mcp` command is an MCP server. Connect it to Claude Code from the config folder, and it answers questions like "Which products at the main store are at risk of stockout this week?" using five tools: `sell_through`, `inventory_status`, `stockout_risk`, `reorder_suggestions`, and `sync_status`.

```bash
cd ~/retail-mcp
claude mcp add retail-mcp --scope project -- retail-mcp
```

The query tools are read-only. `sync_now`, which writes data, and `explore_sql`, which runs arbitrary SQL, are disabled by default; the conditions for enabling them and the risks are in "Operations Details" below and in `docs/DESIGN.md` §12.4.

---

## For Developers

### Running from the Repository

```bash
git clone https://github.com/Trapa-Eureka/retail-mcp.git && cd retail-mcp
npm install
cp .env.example .env       # fill in the values
npm run check              # typecheck + lint + format + test — the required gate for every change
npm run onboard            # = retail-mcp-onboard
npm run agent:folder-scan  # = retail-mcp-scan (dry_run by default; live send requires SEND_MODE=live + --confirm)
npm run dev                # = retail-mcp (MCP server over stdio)
npm run agent:reorder      # = retail-mcp-reorder (Loyverse path)
npm run migrate            # apply the schema to an external DATABASE_URL (run by a human only)
npm run cleanup            # clean up logs/snapshots past the retention period (dry-run by default, run with --confirm)
npm run smoke              # manual smoke against real Loyverse + real DB (humans only)
npm run verify:pack        # fresh-install of the published tarball + run all 5 bins + audit (release gate)
```

You can connect the repository version directly with `claude mcp add retail-mcp --scope project -- npx tsx src/server.ts` (`.mcp.json` is committed).

### Document Map

| Document | Contents | When to read |
|---|---|---|
| `CLAUDE.md` | Agent steering — stack, commands, rules, guardrails | At the start of every agent session (auto-loaded) |
| `docs/SPEC.md` | Product spec — background, metric definitions, goals/non-goals, roadmap, npm distribution policy (§18) | Before feature discussions and scope decisions |
| `docs/DESIGN.md` | Technical design — schema, metric formulas (§3 is the source of truth), ETL, MCP tools, agent, operational reliability (§12) | Required reading before implementing |
| `docs/TESTING.md` | Test strategy — PGlite determinism, golden cases, release gate (§8) | Before writing tests |
| `docs/TASKS.md` | Task backlog — units of work, completion criteria, pre-release review response (T28~T37) | When assigning work |
| `docs/WORKFLOW.md` | AI-native development rules | Once at first + reference during operation |
| `docs/004~010` | Pre-release adversarial review results and per-finding resolution/test cross-reference | When checking security/quality evidence |
| `SECURITY.md` | Private vulnerability reporting procedure, known design boundaries, CI/publish security gates | When you find a vulnerability |
| `CHANGELOG.md` | Change history per release | Before upgrading versions |

### Design Principles

- **Queries = MCP, prediction and sending = agent.** The agent is a thin scheduler that consumes the same core functions as MCP.
- All external IO (POS, DB, sending, clock, LLM) sits behind interfaces, and `src/core/` does pure computation only. Tests make zero network calls (in-process PGlite, fixtures, mocks).
- Live send requires both `SEND_MODE=live` **and** `--confirm`. Warehouse writes go through the ETL path only; MCP tools are read-only.
- The development approach is document → agent implementation → verification (`docs/WORKFLOW.md`). The human (Jin) owns spec, design, review, and approval of live sends / production DB changes.

### Using an External Postgres (Neon/Supabase, etc.)

The default is embedded PGlite, but to gather multiple branches into one DB or to use managed backups, put a connection string in onboarding question 2 (or `DATABASE_URL` in `.env`). In that case a human applies the schema directly:

```bash
retail-mcp-migrate            # dry-run (default): shows only the target host/db name and pending migrations (credentials are not shown)
retail-mcp-migrate --confirm  # actually apply
```

If you run any other command while the schema is missing or only partially applied, it stops immediately with an error that points you to this command instead of a raw Postgres error. Run the query tools under a read-only DB role, and when enabling `sync_now`/`explore_sql`, use a dedicated role without permission to execute dangerous functions (`docs/DESIGN.md` §11.4·§12.4).

### Loyverse POS Path (v0.1 — implemented, production deployment on hold until the pilot is confirmed)

This path syncs sales and inventory from the POS API and sends reorder suggestion emails. `.env` needs `LOYVERSE_API_TOKEN`, `BUSINESS_TIMEZONE`, `RESEND_API_KEY`/`MAIL_FROM`/`REPORT_RECIPIENT`, and (for summary sentences) `ANTHROPIC_API_KEY`. The CSV path does not need an Anthropic key.

1. Fill in `.env` → (if using an external DB) `retail-mcp-migrate --confirm` → `npm run smoke` (always dry-run) to confirm that sync, queries, and the agent connect.
2. For the first live send, switch to `SEND_MODE=live`, then have **a human run** `retail-mcp-reorder --sync --confirm` (repository: `npm run agent:reorder -- --sync --confirm`) once, confirm arrival, and only then register it with the scheduler.
3. Check before sending: that `BUSINESS_TIMEZONE` is the store's actual timezone (the basis for all period calculations; DB storage is UTC), and that `data_last_synced_at` from `sync_status` is recent (default stale threshold 24 hours, `STALE_THRESHOLD_HOURS`).

```bash
# crontab -e — sync + reorder suggestions every Monday at 07:00
0 7 * * 1 cd ~/retail-mcp && retail-mcp-reorder --sync --confirm >> ~/retail-mcp/reorder.log 2>&1
```

With macOS `launchd`, put the same command in `ProgramArguments` of `~/Library/LaunchAgents/com.retail-mcp.reorder.plist` and register it with `launchctl load`.

---

## Operations Details

**Supported environments**: Node.js 20 or later. CI verifies typecheck/lint/format/test and a fresh-install of the published tarball (`verify:pack`) on every PR on `ubuntu-latest`·`macos-latest` × Node 20·22. **Windows has not been verified** — the `ps -o lstart=` used by the file lock's PID-reuse mitigation is POSIX-only, so on Windows it falls back to a PID-only decision without that auxiliary signal (not an error).

**File lock recovery**: If another process has the same embedded data directory open, startup is refused with `FileLockBusyError` (the message includes the owning PID and the action to take). If that process has died, the next startup reclaims the stale lock automatically. There are two cases that need human intervention — **a lock created by another host** (e.g. a network-shared directory, where liveness cannot be checked from this machine) and **a lock with no owning-host information** (e.g. a file created by another tool). Neither is reclaimed automatically; confirm that no retail-mcp is running on any host, then **only delete** `{data directory}.lock` (do not edit or replace). If you delete the lock of a live process, there is a short window in which that process, on exit, may delete the new owner's lock — a residual risk that cannot be fully prevented in code because POSIX has no "delete only if the contents match" (`docs/DESIGN.md` §12.8), and one that does not arise if the convention is followed.

**Email send retries**: If a Resend request fails before an HTTP response is received (timeout, socket dropped after connecting, etc.), it is recorded as "unknown whether it was sent" in `agent_send_log.status='unknown'` and is not retried automatically. Only cases where the server was definitely not reached, such as DNS failure or connection refused, are `failed`. After a human checks the Resend dashboard and re-runs with the same `run_id`, the Resend `Idempotency-Key` prevents duplicate sending — but this is allowed **only within 23 hours of the first attempt (24 hours − 1 hour safety margin)**; after that it is refused with `SendRetryRefusedError` and you are told to run with a new run_id. On a retry within 23 hours, if the previous run was stuck at `sending`, that row is closed as `unknown(stale_sending)` and the run proceeds. Retries after `failed` have no time limit. If `--run-id` is omitted, every run gets a new run_id.

**Retention policy**: `agent_send_log` (one row per run) and `inventory_snapshots` (full inventory per Loyverse sync) keep growing. `npm run cleanup` (humans only, `CLEANUP_RETENTION_DAYS` default 90 days) deletes old rows — dry-run by default, actual deletion with `--confirm`.

**Backup/restore**: Embedded PGlite is plain files under `RETAIL_MCP_DATA_DIR` (default `.retail-mcp/data/`). Stop the process and copy the whole directory to back up; restore it to a new location and point the same environment variable at it to recover. For an external DB, use that service's managed backups.

**Structured logs and exit codes**: `retail-mcp-scan`/`retail-mcp-reorder` write, separately from the human-readable completion line, one JSON line (`{event, runId, status, ...}`) to stdout per run. `0` on completion, `1` when aborted by an unhandled exception. The MCP server does not write this log because its stdout is reserved for the protocol.

**Permission separation**: The five query tools are read-only; `sync_now` (`SYNC_TOOL_ENABLED`) and `explore_sql` (`EXPLORE_SQL_ENABLED`) are disabled by default. `explore_sql` is guarded by a function blocklist + `BEGIN READ ONLY`, but blocking side effects such as advisory locks requires a dedicated DB role, and since role separation is impossible in embedded PGlite it can be enabled there only by explicitly setting `EXPLORE_SQL_ALLOW_PGLITE=true`.

**Security and supply chain**: `SECURITY.md` summarizes the vulnerability reporting procedure and the CI gates (lockfile/tarball audit, secret scan, SBOM, SHA-pinned Actions, `main` branch ruleset, publishing with provenance).

## Status

- 2026-09-02: v0.1 (Loyverse path) implementation complete — production deployment on hold until the pilot is confirmed.
- 2026-09-03: v0.2 (CSV/Excel channel) implementation complete — branch and HQ modes, onboarding CLI, SCM reconciliation, pack-size rounding.
- 2026-09-04: **v0.1.0 first npm publish** — all findings from two pre-release adversarial reviews (59) handled, 8-step release gate passed, published from GitHub Actions with provenance.

## Things to Know

- A single-tenant deployment is assumed. Multi-tenancy that mixes multiple businesses' data in one DB is a non-goal.
- Timestamps are stored in UTC; period boundaries and email display are calculated in the configured business timezone (`BUSINESS_TIMEZONE`).
- Sell-through and reorder suggestions are decision-support information. Before actually placing an order, have a person check outstanding orders, pack sizes, and supplier lead times.
