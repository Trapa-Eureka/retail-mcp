import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMainModule } from "../src/adapters/mainModule.js";

describe("isMainModule (TASKS T29 — npm bin 심볼릭 링크 대응)", () => {
  let dir: string;
  let realFile: string;
  /** Node의 ESM 로더는 기본적으로 realpath로 `import.meta.url`을 만든다(`--preserve-symlinks`
   * 미사용 시) — 이 헬퍼는 그 실제 동작을 흉내낸다. macOS는 `$TMPDIR` 경로 자체가 심볼릭
   * 링크(`/var/folders/... -> /private/var/folders/...`)라 realpath 없이 만든 file URL은
   * 실제 런타임이 주는 값과 달라 테스트가 오탐한다. */
  let moduleUrl: string;
  let originalArgv1: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-mainmodule-"));
    realFile = join(dir, "entry.js");
    await writeFile(realFile, "// dummy entry\n", "utf8");
    moduleUrl = pathToFileURL(await realpath(realFile)).href;
    originalArgv1 = process.argv[1];
  });

  afterEach(async () => {
    if (originalArgv1 === undefined) {
      process.argv.splice(1, 1);
    } else {
      process.argv[1] = originalArgv1;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("argv[1]이 모듈 경로와 그대로 같으면 true다", () => {
    process.argv[1] = realFile;
    expect(isMainModule(moduleUrl)).toBe(true);
  });

  it("argv[1]이 모듈을 가리키는 심볼릭 링크여도 true다 (npm bin 링크 재현)", async () => {
    const symlinkPath = join(dir, "bin-link.js");
    await symlink(realFile, symlinkPath);
    process.argv[1] = symlinkPath;
    expect(isMainModule(moduleUrl)).toBe(true);
  });

  it("argv[1]이 다른 파일이면 false다", async () => {
    const otherFile = join(dir, "other.js");
    await writeFile(otherFile, "// other\n", "utf8");
    process.argv[1] = otherFile;
    expect(isMainModule(moduleUrl)).toBe(false);
  });

  it("argv[1]이 없으면 false다", () => {
    process.argv.splice(1, 1);
    expect(isMainModule(moduleUrl)).toBe(false);
  });

  it("argv[1]이 존재하지 않는 경로면(realpath 실패) false다", () => {
    process.argv[1] = join(dir, "does-not-exist.js");
    expect(isMainModule(moduleUrl)).toBe(false);
  });
});
