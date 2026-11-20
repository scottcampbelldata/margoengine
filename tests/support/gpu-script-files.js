// The script files a package GPU or browser test runs, for the checks over them (tests/gpu-start-path.test.js,
// tests/gpu-compat-honoured.test.js).
import { join, normalize } from 'node:path';

/** [file run, folder it runs in] for each `node <file>` part of a script, following its `cd` parts. */
export function nodeFiles(command, cwd) {
  const out = [];
  let dir = cwd;
  for (const part of command.split(/\s*&&\s*/)) {
    const cd = /^cd\s+(\S+)$/.exec(part);
    if (cd) dir = normalize(join(dir, cd[1]));
    const node = /^node\s+(?:--\S+\s+)*([^\s-]\S*\.(?:mjs|js|cjs))\b/.exec(part);
    if (node) out.push([normalize(join(dir, node[1])), dir]);
  }
  return out;
}
