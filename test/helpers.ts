import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway MINI_LETTA_HOME per test. */
export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "mini-letta-test-"));
}
