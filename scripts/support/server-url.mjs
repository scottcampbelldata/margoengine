/**
 * The URL a server process prints once it listens: the first capture of `pattern` in its stdout or stderr. Start the
 * server on port 0 and read its URL here, never poll a fixed port: on a fixed port another suite's server (another
 * worktree's, under shared GPU slots) answers too, and the suite then tests that server's build while its own exited
 * with "address in use". Rejects, with the output so far, when the process exits first or `ms` passes.
 * @param {import('node:child_process').ChildProcess} child spawned with stdout and stderr piped
 * @param {{ pattern: RegExp, name: string, ms?: number }} options
 * @returns {Promise<{ url: string, output: () => string }>}
 */
export function serverUrl(child, { pattern, name, ms = 30_000 }) {
  let output = '';
  const read = () => output;
  return new Promise((resolve, reject) => {
    const finish = (error, url) => {
      clearTimeout(timer);
      child.stdout.off('data', data);
      child.stderr.off('data', data);
      child.off('exit', exit);
      // The output keeps being collected for the caller's error messages.
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      if (error) reject(error);
      else resolve({ url, output: read });
    };
    const data = (chunk) => {
      output += chunk;
      const url = pattern.exec(output)?.[1];
      if (url) finish(null, url);
    };
    const exit = (code) => finish(new Error(`${name} exited (code ${code}) before it printed its URL:\n${output}`));
    const timer = setTimeout(
      () => finish(new Error(`${name} printed no URL within ${Math.round(ms / 1000)} s:\n${output}`)),
      ms,
    );
    child.stdout.on('data', data);
    child.stderr.on('data', data);
    child.on('exit', exit);
  });
}
