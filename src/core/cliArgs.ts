/**
 * Minimal CLI argument parser — handles only one thing: a valued flag in `--name=value` form.
 *
 * Unlike the boolean flags such as `process.argv.includes("--confirm")` that the `main()` of
 * `agent/reorder.ts`/`agent/folderScan.ts` used so far, `--run-id` needs a value, so this was
 * split out (second adversarial review SR2-MAIL-001, TASKS response). The `--name value`
 * (space-separated) form is deliberately unsupported — it avoids the ambiguity of whether the
 * next token is a value or a new flag.
 */
export function parseNamedArg(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}
