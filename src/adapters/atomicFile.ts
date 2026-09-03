/**
 * 원자적 파일 쓰기 공용 유틸리티(TASKS T31, DESIGN §12.5) — 같은 디렉터리의 임시 파일에 쓰고
 * `fsync` 후 `rename`으로 교체한다(POSIX `rename(2)`은 원자적이라, 쓰는 도중 프로세스가
 * 죽거나 다른 프로세스가 동시에 읽어도 부분적으로 쓰인 파일을 보지 않는다).
 *
 * 임시 파일명은 `<targetPath>.tmp-<pid>-<타임스탬프>`(접미사 방식, 확장자를 안 바꾸는 게
 * 아니라 뒤에 덧붙인다) — `folderScan.ts`의 `listInventoryFiles()`가 이미 `/\.(csv|xlsx)$/i`로
 * 파일명 "끝"이 그 확장자인 파일만 재고 파일로 인식하므로, 이 이름은 그 필터에 자연히
 * 걸러진다(별도 "임시 파일 무시" 로직을 새로 만들 필요가 없다 — 006 DATA-004).
 *
 * `folderScan.ts`의 snapshot 쓰기(DATA-004)와 `cli/onboard.ts`의 `.env` 쓰기(SEC-005, TASKS
 * T32)가 이 유틸리티를 공유한다.
 */
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface WriteFileAtomicOptions {
  /** 새로 만드는 파일의 권한(예: `.env`는 0o600, SEC-005). 미지정 시 프로세스 umask를 따른다. */
  mode?: number;
}

export async function writeFileAtomic(
  targetPath: string,
  content: string,
  opts: WriteFileAtomicOptions = {},
): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(
    dir,
    `${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const handle = await open(tmpPath, "w", opts.mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync(); // fsync — rename 전에 내용이 실제로 디스크에 반영되게 한다.
  } finally {
    await handle.close();
  }

  try {
    await rename(tmpPath, targetPath);
  } catch (err) {
    // rename 실패 시 임시 파일이 고아로 남지 않게 정리한다 — 원인은 그대로 전파한다.
    await rm(tmpPath, { force: true });
    throw err;
  }
}
