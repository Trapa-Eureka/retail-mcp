/**
 * 디렉터리 단위 배타 접근을 위한 파일 락. PGlite는 같은 데이터 디렉터리를 여러 프로세스가
 * 동시에 열어도 에러를 내지 않고 나중에 연 프로세스의 쓰기를 조용히 유실한다(SPEC.md §12
 * "PGlite 다중 프로세스 동시 접근" 스파이크 결과) — PGlite 자체의 동시성 보장에 기대지 않고,
 * 이 모듈이 PID+타임스탬프 락 파일로 "이미 다른 살아있는 프로세스가 쓰고 있으면 시작을
 * 거부"하게 만든다(TASKS.md T13).
 *
 * 락 파일은 보호 대상 디렉터리 밖에 둔다(`{targetPath}.lock`) — PGlite 데이터 디렉터리
 * 안에 낯선 파일을 넣지 않기 위해서다.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileLock {
  /** 이 프로세스가 보유한 락이 맞는지 확인 후 락 파일을 지운다. 다른 프로세스 소유면 무시한다. */
  release(): Promise<void>;
}

export interface FileLockOptions {
  /** 테스트 주입용. 기본값: process.pid. */
  pid?: number;
  /** 테스트 주입용. 기본값: process.kill(pid, 0)로 생존 여부 확인. */
  isAlive?: (pid: number) => boolean;
  /** 테스트 주입용. 기본값: () => new Date(). */
  nowFn?: () => Date;
  /** stale lock을 회수한 뒤 재시도할 최대 횟수(다른 프로세스와의 경합 대비). 기본 5. */
  maxRetries?: number;
}

interface LockFileContent {
  pid: number;
  acquiredAt: string;
}

export class FileLockBusyError extends Error {
  constructor(
    lockPath: string,
    public readonly holderPid: number,
    acquiredAt: string,
  ) {
    super(
      `${lockPath}를 프로세스 ${holderPid}가 이미 사용 중입니다(${acquiredAt}부터). ` +
        "같은 데이터 디렉터리를 두 프로세스가 동시에 열면 PGlite가 조용히 데이터를 잃을 수 " +
        `있습니다(SPEC §12) — 그 프로세스가 끝난 뒤 다시 시도하세요. 프로세스가 이미 죽었는데도 ` +
        `이 에러가 계속 뜨면 ${lockPath}를 수동으로 삭제하세요.`,
    );
    this.name = "FileLockBusyError";
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function defaultIsAlive(pid: number): boolean {
  try {
    // signal 0: 신호를 실제로 보내지 않고 프로세스 존재·권한만 확인한다.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: 그 PID의 프로세스가 없다(죽었다) — stale lock. EPERM 등 다른 에러는 존재는
    // 하지만 신호 권한이 없다는 뜻이므로 "살아있다"로 보수적으로 취급한다.
    return isNodeErrnoException(err) ? err.code !== "ESRCH" : true;
  }
}

function lockPathFor(targetPath: string): string {
  return `${targetPath}.lock`;
}

async function tryCreateLockFile(lockPath: string, content: LockFileContent): Promise<boolean> {
  try {
    // 락 파일의 부모 디렉터리가 아직 없을 수 있다 — 예를 들어 임베디드 PGlite 기본 경로
    // `.retail-mcp/data`(DESIGN §12.1, 새 설치 첫 실행)는 그 부모 `.retail-mcp/`조차 아직
    // 없는 완전히 새 디렉터리에서 시작한다. 착수 중 발견(QA-001 tarball smoke test,
    // `scripts/verifyPack.ts`) — mkdir 없이 바로 `wx`로 쓰면 ENOENT로 실패했다. `recursive:
    // true`라 이미 있어도 안전하고, 동시에 두 프로세스가 mkdir해도 에러 없이 성공한다(POSIX
    // mkdir -p와 동일 시맨틱) — 아래 'wx' 배타 생성이 실제 경합 조정을 맡는다.
    await mkdir(path.dirname(lockPath), { recursive: true });
    // 'wx': 파일이 이미 있으면 실패하는 배타적 생성 — 단일 syscall이라 두 프로세스가 동시에
    // 시도해도 하나만 성공한다(TOCTOU 경합 없음, SPEC §12 스파이크가 재현한 문제의 해결책).
    await writeFile(lockPath, JSON.stringify(content), { flag: "wx" });
    return true;
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "EEXIST") return false;
    throw err;
  }
}

async function readLockFile(lockPath: string): Promise<LockFileContent | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      typeof (parsed as { acquiredAt?: unknown }).acquiredAt === "string"
    ) {
      return parsed as LockFileContent;
    }
    throw new Error("형식이 예상과 다릅니다.");
  } catch (err) {
    throw new Error(
      `${lockPath}의 내용을 해석할 수 없습니다(손상됐을 수 있습니다). ` +
        "다른 프로세스가 이 디렉터리를 쓰고 있지 않은지 확인한 뒤 파일을 수동으로 삭제하세요.",
      { cause: err },
    );
  }
}

/**
 * `targetPath`(디렉터리 등)에 대한 배타 락을 획득한다. 이미 살아있는 프로세스가 보유 중이면
 * `FileLockBusyError`를 던진다. 죽은 프로세스가 남긴 stale lock은 자동으로 회수하고 재시도한다.
 */
export async function acquireFileLock(
  targetPath: string,
  opts: FileLockOptions = {},
): Promise<FileLock> {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const nowFn = opts.nowFn ?? (() => new Date());
  const maxRetries = opts.maxRetries ?? 5;
  const lockPath = lockPathFor(targetPath);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const content: LockFileContent = { pid, acquiredAt: nowFn().toISOString() };
    if (await tryCreateLockFile(lockPath, content)) {
      return {
        async release(): Promise<void> {
          const current = await readLockFile(lockPath);
          if (current === null || current.pid !== pid) return; // 우리 소유가 아니면 그대로 둔다.
          try {
            await rm(lockPath);
          } catch (err) {
            if (!(isNodeErrnoException(err) && err.code === "ENOENT")) throw err;
          }
        },
      };
    }

    const holder = await readLockFile(lockPath);
    if (holder === null) continue; // 그 사이 다른 프로세스가 release했다 — 바로 재시도.

    if (isAlive(holder.pid)) {
      throw new FileLockBusyError(lockPath, holder.pid, holder.acquiredAt);
    }

    // stale lock — 죽은 프로세스가 남긴 것이므로 회수하고 재시도한다.
    try {
      await rm(lockPath);
    } catch (err) {
      if (!(isNodeErrnoException(err) && err.code === "ENOENT")) throw err;
    }
  }

  throw new Error(
    `${lockPath} 획득을 ${maxRetries}회 재시도했지만 계속 다른 프로세스와 경합했습니다. ` +
      "잠시 후 다시 시도하세요.",
  );
}

/** acquire → fn 실행 → release(성공/실패 무관하게 항상 시도)까지 한 번에 처리하는 편의 함수. */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const lock = await acquireFileLock(targetPath, opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
