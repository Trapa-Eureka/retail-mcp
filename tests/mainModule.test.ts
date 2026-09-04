import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMainModule } from "../src/adapters/mainModule.js";

describe("isMainModule (TASKS T29 — npm bin symlink handling)", () => {
  let dir: string;
  let realFile: string;
  /** Node's ESM loader builds `import.meta.url` from the realpath by default (when
   * `--preserve-symlinks` is not used) — this helper mimics that actual behaviour. On macOS the
   * `$TMPDIR` path itself is a symlink (`/var/folders/... -> /private/var/folders/...`), so a
   * file URL built without realpath differs from what the real runtime gives and the test would
   * false-positive. */
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

  it("is true when argv[1] equals the module path as-is", () => {
    process.argv[1] = realFile;
    expect(isMainModule(moduleUrl)).toBe(true);
  });

  it("is true even when argv[1] is a symlink pointing at the module (npm bin link reproduction)", async () => {
    const symlinkPath = join(dir, "bin-link.js");
    await symlink(realFile, symlinkPath);
    process.argv[1] = symlinkPath;
    expect(isMainModule(moduleUrl)).toBe(true);
  });

  it("is false when argv[1] is a different file", async () => {
    const otherFile = join(dir, "other.js");
    await writeFile(otherFile, "// other\n", "utf8");
    process.argv[1] = otherFile;
    expect(isMainModule(moduleUrl)).toBe(false);
  });

  it("is false when argv[1] is missing", () => {
    process.argv.splice(1, 1);
    expect(isMainModule(moduleUrl)).toBe(false);
  });

  it("is false when argv[1] is a non-existent path (realpath fails)", () => {
    process.argv[1] = join(dir, "does-not-exist.js");
    expect(isMainModule(moduleUrl)).toBe(false);
  });
});
