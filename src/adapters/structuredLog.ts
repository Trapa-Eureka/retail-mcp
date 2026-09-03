/**
 * 구조화 로그 한 줄(007 OPS-005, TASKS T34) — 지금까지 CLI 진입점(agent/folderScan.ts,
 * agent/reorder.ts)은 사람이 읽는 문장 하나(`console.log("... run_id=${runId} ...")`)만
 * 남겼다 — 로그 수집기나 알림 스크립트가 실행 결과를 뽑아내려면 정규식으로 그 문장을
 * 파싱해야 했다(007 검수 지적: "구조화 로그 형식이 없다"). 이 모듈은 기존 사람이 읽는 로그를
 * 대체하지 않고, **한 줄 더 JSON으로도** 남긴다 — 최소 변경으로 파싱 가능한 신호를 추가한다.
 *
 * stdout에 쓴다 — MCP 서버(server.ts)는 stdout이 프로토콜 전용이라 이 함수를 쓰면 안 된다.
 * CLI 진입점(사람/cron이 실행, stdout이 순수 로그)에서만 쓴다.
 */
export interface StructuredLogEvent {
  /** 이벤트 종류 — 로그를 필터링할 때 쓰는 안정적 문자열(예: "folder_scan_completed"). */
  event: string;
  runId: string;
  status: string;
  [key: string]: unknown;
}

export function logStructured(event: StructuredLogEvent): void {
  console.log(JSON.stringify({ ...event, loggedAt: new Date().toISOString() }));
}
