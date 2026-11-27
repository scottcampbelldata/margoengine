// Every script that downloads or installs something reads its arguments here before it does any work, so asking for
// help or mistyping a flag never starts a download (tests/download-script-arguments.test.js).
import { parseArgs } from 'node:util';

/**
 * Reads a download script's arguments. Returns their values when the script should run, or null after `--help`
 * (usage printed, exit code 0) or an argument the script does not take (error and usage printed, exit code 2).
 * On null the caller does nothing more, so neither case reaches the network or writes a file.
 * `options` is the `node:util` parseArgs option table for the flags the script takes.
 */
export function downloadArguments(usage, options = {}, argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { ...options, help: { type: 'boolean', short: 'h' } } }));
  } catch (error) {
    console.error(`${error.message}\n\n${usage}`);
    process.exitCode = 2;
    return null;
  }
  if (!values.help) return values;
  console.log(usage);
  return null;
}
