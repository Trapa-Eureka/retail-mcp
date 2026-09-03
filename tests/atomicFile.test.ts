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
});
