import path from "node:path";

let loaded = false;

/**
 * The repo's .env, read once, for code that runs before `core()` does: the
 * proxy's lock needs CELESTE_PASSCODE and must not open the database to get it.
 */
export function loadRepoEnv(): void {
  if (loaded) return;
  loaded = true;
  try {
    process.loadEnvFile(path.resolve(process.cwd(), "../../.env"));
  } catch {
    /* no .env: nothing is set */
  }
}
