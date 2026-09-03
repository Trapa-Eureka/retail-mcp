/**
 * 최소 CLI 인자 파서 — `--name=value` 형태의 값 있는 플래그 하나만 다룬다.
 *
 * `agent/reorder.ts`/`agent/folderScan.ts`의 `main()`이 지금까지 쓰던
 * `process.argv.includes("--confirm")` 같은 boolean 플래그와 달리 `--run-id`는 값이
 * 필요해서 새로 뺐다(2차 적대적 검수 SR2-MAIL-001, TASKS 대응). `--name value`(공백 구분)
 * 형식은 일부러 지원하지 않는다 — 다음 토큰이 값인지 새 플래그인지 모호해지는 걸 피한다.
 */
export function parseNamedArg(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}
