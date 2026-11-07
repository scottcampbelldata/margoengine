// The Python a test or check starts. On Windows `python3` is an app execution alias, and a spawn of one failed with EINVAL
// about once in thousands of runs under load, so the interpreter the Python install manager put in place is taken first and
// the alias is never started.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Its path or command, undefined on a machine with none. Anything but "not found" from a probe is thrown: a check must not pass by skipping its script. */
export function findPython({ run = spawnSync, platform = process.platform, env = process.env } = {}) {
  const installs = platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Python') : '',
    installed = installs && existsSync(installs)
      ? readdirSync(installs)
          .filter((name) => name.startsWith('pythoncore-'))
          .map((name) => join(installs, name, 'python.exe'))
          .find(existsSync)
      : undefined;
  if (installed) return installed;
  return ['python3', 'python'].find((command) => {
    const { error, status } = run(command, ['--version']);
    if (error && error.code !== 'ENOENT') throw error;
    return status === 0;
  });
}
