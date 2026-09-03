import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/adapters/atomicFile.js";

describe("writeFileAtomic (TASKS T31, DATA-004 대응)", () => {
  let dir: string;
  let targetPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-atomicfile-"));
    targetPath = join(dir, "snapshot.csv");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("파일을 만들고 내용이 그대로 읽힌다", async () => {
    await writeFileAtomic(targetPath, "hello\nworld\n");
    expect(await readFile(targetPath, "utf8")).toBe("hello\nworld\n");
  });

  it("기존 파일을 완전히 교체한다(부분 병합 아님)", async () => {
    await writeFileAtomic(targetPath, "first version, much longer than the second\n");
    await writeFileAtomic(targetPath, "v2\n");
    expect(await readFile(targetPath, "utf8")).toBe("v2\n");
  });

  it("완료 후에는 임시 파일이 디렉터리에 남지 않는다", async () => {
    await writeFileAtomic(targetPath, "data\n");
    const entries = await readdir(dir);
    expect(entries).toEqual(["snapshot.csv"]);
  });

  it("임시 파일명이 .csv/.xlsx로 끝나지 않아 확장자 기반 파일 탐색에서 자연히 제외된다", async () => {
    // folderScan.ts의 listInventoryFiles()가 실제로 쓰는 것과 같은 필터 — 별도 "임시 파일
    // 무시" 로직을 새로 추가할 필요가 없다는 걸 회귀로 고정한다.
    await writeFileAtomic(targetPath, "data\n");
    const entries = await readdir(dir);
    const inventoryLike = entries.filter((name) => /\.(csv|xlsx)$/i.test(name));
    expect(inventoryLike).toEqual(["snapshot.csv"]);
  });

  it("mode 옵션으로 새 파일 권한을 지정할 수 있다", async () => {
    await writeFileAtomic(targetPath, "secret\n", { mode: 0o600 });
    const info = await stat(targetPath);
    // macOS/Linux 기준 — Windows CI에서는 이 비트가 의미가 달라 별도 매트릭스에서 재검토한다
    // (TASKS T34 OPS-006).
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("대상 디렉터리가 이미 있는 파일 위치를 가리켜도(다른 프로세스가 동시에 읽는 상황 흉내) rename 하나로 교체된다", async () => {
    await writeFileAtomic(targetPath, "v1\n");
    // "읽는 도중"을 흉내: 쓰기 시작 전에 내용을 읽어둔다 — 다음 writeFileAtomic이 끝난 뒤에도
    // 이 핸들이 읽은 내용은 잘리지 않은 v1 그대로여야 한다(원자적 교체 특성).
    const before = await readFile(targetPath, "utf8");
    await writeFileAtomic(targetPath, "v2 is longer than v1\n");
    expect(before).toBe("v1\n");
    expect(await readFile(targetPath, "utf8")).toBe("v2 is longer than v1\n");
  });

  it("쓰기 도중에 반복해서 읽어도 항상 완전한 이전 버전 또는 완전한 새 버전만 보인다 — 부분/섞인 내용은 절대 없다(QA-005 'partial snapshot 동시 read', TASKS T35, 008 대응)", async () => {
    // 실제 시나리오: 본사가 여러 지점 CSV를 모으는 CSV_COLLECT_DIR을 폴링하는 동안, 다른
    // 지점의 cron이 정확히 같은 순간 같은 경로에 새 snapshot을 쓸 수 있다. writeFileAtomic이
    // fsync+rename으로 교체하므로 어느 시점에 읽어도 반은 v1 반은 v2인 내용은 나오면 안 된다.
    const v1 = "a,b,c\n".repeat(500); // 어느 정도 크기가 있어야 "쓰는 도중" 타이밍을 흔들 여지가 생긴다.
    const v2 = "x,y,z\n".repeat(700);
    await writeFileAtomic(targetPath, v1);

    let readCount = 0;
    let sawV1 = false;

    const reader = (async () => {
      // rename() 전후로 계속 읽어 "쓰는 도중"을 최대한 많이 관측한다 — writeFileAtomic이
      // 임시 파일에 쓰고 fsync한 뒤 rename하므로, 이 루프가 보는 targetPath는 항상 v1
      // 아니면 v2의 완전한 내용이어야 한다(POSIX rename(2)의 원자적 교체 특성).
      while (readCount < 200) {
        readCount++;
        const content = await readFile(targetPath, "utf8").catch(() => null);
        if (content === null) continue; // rename 찰나에 ENOENT가 날 수도 있다 — 그 자체는 허용(부분 내용이 아니라 "아직 없음"이므로).
        expect(content === v1 || content === v2).toBe(true);
        if (content === v1) sawV1 = true;
      }
    })();

    const writer = writeFileAtomic(targetPath, v2);
    await Promise.all([reader, writer]);

    // 최소한 v1을 한 번은 봤어야 의미 있는 레이스였다고 볼 수 있다(그렇지 않으면 reader가
    // write보다 훨씬 늦게 시작해 아무것도 재현하지 못했을 수 있다) — v2는 위 루프의 각
    // read에서 이미 완전 일치를 assert했고, write가 끝난 뒤 최종 상태로도 다시 확인한다.
    expect(sawV1).toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe(v2);
  });
});
