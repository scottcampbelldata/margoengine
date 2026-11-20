// `--help` / `-h` for scripts that run work: print the usage before any build, lock or browser starts.
// A script's entry point skips its work when the usage was printed: `if (!showHelp(usage)) { ... }`, so a help run ends
// by its event loop with code 0. It never calls process.exit, which can hold the exit for ever (KB-OWN-EXIT1,
// KB-OWN-EXIT2).

/** Whether the arguments ask for help. */
export const wantsHelp = (args = process.argv.slice(2)) => args.includes('--help') || args.includes('-h');

/** Print `usage` when the arguments ask for help, and say whether it did; otherwise do nothing and return false. */
export function showHelp(usage, args = process.argv.slice(2)) {
  if (!wantsHelp(args)) return false;
  console.log(usage.trimEnd());
  return true;
}
