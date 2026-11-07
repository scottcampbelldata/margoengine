// Runs one of the allocation probes (support/*-allocation-probe.mjs) in a fresh process and returns its JSON. Fresh,
// because other tests install overrides that make the solver's calls megamorphic, and because the flags must be set
// before V8 starts: --no-concurrent-recompilation compiles on the main thread the moment a function earns it, so the
// tier a window measures depends on the calls run, never on the machine's load. --no-concurrent-sparkplug does the same
// for baseline code, which macOS arm64 compiles on a background thread by default (tests/frame-alloc.test.js).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const runAllocationProbe = (name) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--allow-natives-syntax',
        '--no-concurrent-recompilation',
        '--no-concurrent-sparkplug',
        fileURLToPath(new URL(`./${name}-allocation-probe.mjs`, import.meta.url)),
      ],
      { encoding: 'utf8', timeout: 240_000 },
    ),
  );
