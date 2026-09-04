/**
 * One structured log line (007 OPS-005, TASKS T34) — until now the CLI entry points
 * (agent/folderScan.ts, agent/reorder.ts) left only a single human-readable sentence
 * (`console.log("... run_id=${runId} ...")`) — a log collector or alerting script had to parse
 * that sentence with a regex to extract the run result (review 007 finding: "no structured log
 * format"). This module does not replace the existing human-readable log; it emits **one more
 * line as JSON** — adding a parseable signal with minimal change.
 *
 * Writes to stdout — the MCP server (server.ts) must not use this function because its stdout
 * is reserved for the protocol. Use it only from CLI entry points (run by a human/cron, stdout
 * is pure log).
 */
export interface StructuredLogEvent {
  /** Event kind — a stable string used to filter logs (e.g. "folder_scan_completed"). */
  event: string;
  runId: string;
  status: string;
  [key: string]: unknown;
}

export function logStructured(event: StructuredLogEvent): void {
  console.log(JSON.stringify({ ...event, loggedAt: new Date().toISOString() }));
}
