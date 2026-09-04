/**
 * Shared atomic file write utility (TASKS T31, DESIGN §12.5) — writes to a temporary file in
 * the same directory, then `fsync`s and replaces the target with `rename` (POSIX `rename(2)` is
 * atomic, so even if the process dies mid-write or another process reads concurrently, nobody
 * ever sees a partially written file).
 *
 * The temporary file name is `<targetPath>.tmp-<pid>-<timestamp>` (suffix style: the extension
 * is not changed, the suffix is appended after it) — `listInventoryFiles()` in `folderScan.ts`
 * already recognises only files whose name *ends* with `/\.(csv|xlsx)$/i` as inventory files,
 * so this name is naturally filtered out (no separate "ignore temp files" logic is needed —
 * 006 DATA-004).
 *
 * The snapshot write in `folderScan.ts` (DATA-004) and the `.env` write in `cli/onboard.ts`
 * (SEC-005, TASKS T32) share this utility.
 */
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface WriteFileAtomicOptions {
  /** Permission bits of the newly created file (e.g. 0o600 for `.env`, SEC-005). Follows the process umask when omitted. */
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
    await handle.sync(); // fsync — make sure the content actually reaches disk before the rename.
  } finally {
    await handle.close();
  }

  try {
    await rename(tmpPath, targetPath);
  } catch (err) {
    // If the rename fails, clean up so the temp file is not left orphaned — the cause is propagated as-is.
    await rm(tmpPath, { force: true });
    throw err;
  }
}
