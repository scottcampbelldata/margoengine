// KB-OWN-EXIT2: whether a script ends by its event loop or through process.exit. process.exit shuts the V8 platform
// down while the isolate lives, and a V8 background task waiting on a main-thread collection then holds the exit for
// ever (KB-OWN-EXIT1). A natural end runs 'beforeExit' first; process.exit never does. endRecorder(folder) writes a
// module that every Node process started with `env` preloads (NODE_OPTIONS reaches detached children through their
// environment); each records "<argv[2]> loop <code>" or "<argv[2]> process.exit <code>" when it ends.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function endRecorder(folder, base = process.env) {
  const record = join(folder, 'ends.log'),
    preload = join(folder, 'record-end.mjs');
  writeFileSync(
    preload,
    [
      "import { appendFileSync } from 'node:fs';",
      `const record = ${JSON.stringify(record)}, verb = process.argv[2];`,
      'let natural = false;',
      "process.on('beforeExit', () => { natural = true; });",
      "process.on('exit', (code) => appendFileSync(record, `${verb} ${natural ? 'loop' : 'process.exit'} ${code}\\n`));",
      '',
    ].join('\n'),
  );
  return {
    env: { ...base, NODE_OPTIONS: `${base.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() },
    lines: () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n') : []),
  };
}
