// Every script that downloads or installs something reads its arguments here before it does any work, so asking for
// help or mistyping a flag never starts a download (tests/download-script-arguments.test.js).
import { parseArgs } from 'node:util';

/**
 * Reads a download script's arguments. Returns their values when the script should run, or null after `--help`
 * (usage printed, exit code 0) or an argument the script does not take (error and usage printed, exit code 2).
 * On null the caller does nothing more, so neither case reaches the network or writes a file.
 * `options` is the `node:util` parseArgs option table for the flags the script takes. `positionals` is how many bare
 * arguments it needs (default 0); they are returned as `values.positionals`.
 */
export function downloadArguments(usage, options = {}, argv = process.argv.slice(2), positionals = 0) {
  let values;
  try {
    const parsed = parseArgs({
      args: argv,
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      allowPositionals: positionals > 0,
    });
    values = parsed.values;
    if (positionals && !values.help) {
      if (parsed.positionals.length !== positionals)
        throw new TypeError(`Expected ${positionals} argument(s), got ${parsed.positionals.length}`);
      values.positionals = parsed.positionals;
    }
  } catch (error) {
    console.error(`${error.message}\n\n${usage}`);
    process.exitCode = 2;
    return null;
  }
  if (!values.help) return values;
  console.log(usage);
  return null;
}
