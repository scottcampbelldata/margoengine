// The check-name filter of a browser driver's command line: the first argument that is not a flag, so
// `node test-extensions-browser.js --compat KHR_texture` runs the KHR_texture checks on the WebGL2 layer, and `--compat`
// alone runs every check there (it was read as a filter that matched no check, so the run passed having run none).
export function nameFilter(argv = process.argv.slice(2)) {
  return argv.find((arg) => !arg.startsWith('--'));
}
/** The entries of `checks` whose name holds `filter` (all without one); refuses a filter that matches none. */
export function selectChecks(checks, filter) {
  const names = Object.keys(checks).filter((name) => !filter || name.includes(filter));
  if (!names.length) throw new Error(`No check name holds "${filter}"; names: ${Object.keys(checks).join(', ')}`);
  return names;
}
