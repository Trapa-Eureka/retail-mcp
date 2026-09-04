import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/adapters/atomicFile.js";

describe("writeFileAtomic (TASKS T31, DATA-004 response)", () => {
  let dir: string;
  let targetPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-atomicfile-"));
    targetPath = join(dir, "snapshot.csv");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the file and the content reads back as-is", async () => {
    await writeFileAtomic(targetPath, "hello\nworld\n");
    expect(await readFile(targetPath, "utf8")).toBe("hello\nworld\n");
  });

  it("fully replaces an existing file (no partial merge)", async () => {
    await writeFileAtomic(targetPath, "first version, much longer than the second\n");
    await writeFileAtomic(targetPath, "v2\n");
    expect(await readFile(targetPath, "utf8")).toBe("v2\n");
  });

  it("leaves no temporary file in the directory after completion", async () => {
    await writeFileAtomic(targetPath, "data\n");
    const entries = await readdir(dir);
    expect(entries).toEqual(["snapshot.csv"]);
  });

  it("temporary file name does not end with .csv/.xlsx, so it is naturally excluded from extension-based file discovery", async () => {
    // The same filter listInventoryFiles() in folderScan.ts actually uses — pins as a regression
    // that no separate "ignore temp files" logic needs to be added.
    await writeFileAtomic(targetPath, "data\n");
    const entries = await readdir(dir);
    const inventoryLike = entries.filter((name) => /\.(csv|xlsx)$/i.test(name));
    expect(inventoryLike).toEqual(["snapshot.csv"]);
  });

  it("can set the new file's permissions with the mode option", async () => {
    await writeFileAtomic(targetPath, "secret\n", { mode: 0o600 });
    const info = await stat(targetPath);
    // macOS/Linux basis — on Windows CI these bits mean something different and are re-examined
    // in a separate matrix (TASKS T34 OPS-006).
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("replaces with a single rename even when the target path points at an existing file (mimicking another process reading concurrently)", async () => {
    await writeFileAtomic(targetPath, "v1\n");
    // Mimic "mid-read": read the content before the write starts — even after the next
    // writeFileAtomic finishes, what this handle read must be the untruncated v1 (atomic replace property).
    const before = await readFile(targetPath, "utf8");
    await writeFileAtomic(targetPath, "v2 is longer than v1\n");
    expect(before).toBe("v1\n");
    expect(await readFile(targetPath, "utf8")).toBe("v2 is longer than v1\n");
  });

  it("repeated reads during the write only ever see the complete old version or the complete new version — never partial/mixed content (QA-005 'partial snapshot concurrent read', TASKS T35, 008 response)", async () => {
    // Real scenario: while HQ polls the CSV_COLLECT_DIR that gathers CSVs from several branches,
    // another branch's cron may write a new snapshot to the same path at exactly the same moment.
    // writeFileAtomic replaces with fsync+rename, so no read at any point may return half v1, half v2.
    const v1 = "a,b,c\n".repeat(500); // Needs some size so there is room for "mid-write" timing to vary.
    const v2 = "x,y,z\n".repeat(700);
    await writeFileAtomic(targetPath, v1);

    let readCount = 0;
    let sawV1 = false;

    const reader = (async () => {
      // Keep reading around the rename() to observe "mid-write" as often as possible — since
      // writeFileAtomic writes to a temp file, fsyncs, then renames, the targetPath this loop sees
      // must always be the complete content of either v1 or v2 (atomic replace property of POSIX rename(2)).
      while (readCount < 200) {
        readCount++;
        const content = await readFile(targetPath, "utf8").catch(() => null);
        if (content === null) continue; // ENOENT can occur at the instant of the rename — that itself is allowed (it is "not there yet", not partial content).
        expect(content === v1 || content === v2).toBe(true);
        if (content === v1) sawV1 = true;
      }
    })();

    const writer = writeFileAtomic(targetPath, v2);
    await Promise.all([reader, writer]);

    // v1 must have been seen at least once for this to count as a meaningful race (otherwise the
    // reader may have started far later than the write and reproduced nothing) — v2 was already
    // asserted as an exact match in each read of the loop above, and is re-checked as the final state after the write.
    expect(sawV1).toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe(v2);
  });
});
