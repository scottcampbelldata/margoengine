// `--help` / `-h` for scripts that run work: print the usage and exit 0 before any build, lock or browser starts.
// Call it first in a script's entry point: `exitOnHelp(usage)`.

/** Whether the arguments ask for help. */
export const wantsHelp = (args = process.argv.slice(2)) => args.includes('--help') || args.includes('-h');

/** Print `usage` and exit 0 when the arguments ask for help; otherwise do nothing. */
export function exitOnHelp(usage, args = process.argv.slice(2)) {
  if (!wantsHelp(args)) return;
  console.log(usage.trimEnd());
  process.exit(0);
}
