import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('text options that may carry subtree registrations cannot promise an ordinary tree', { timeout: 30000 }, () => {
  const results = fileURLToPath(new URL('../../../test-results/', import.meta.url));
  mkdirSync(results, { recursive: true });
  const folder = mkdtempSync(join(results, 'behavior-text-types-'));
  const modulePath = (name) => fileURLToPath(new URL(`../dist/${name}.js`, import.meta.url)).replaceAll('\\', '/');
  const source = `
    import { parseTreeText, type TreeTextOptions } from ${JSON.stringify(modulePath('text'))};
    import { type TreeDocument } from ${JSON.stringify(modulePath('index'))};
    import { type SubtreeDocument } from ${JSON.stringify(modulePath('subtrees'))};
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Expect<T extends true> = T;
    declare const options: TreeTextOptions;
    declare const optional: TreeTextOptions | undefined;
    const withOptions = parseTreeText('subtree(name="leaf")', options);
    const maybeOptions = parseTreeText('wait(seconds=0)', optional);
    const registered = parseTreeText('subtree(name="leaf")', { subtrees: { leaf: { type: 'wait', seconds: 0 } } });
    const ordinary = parseTreeText('wait(seconds=0)');
    const handlers = parseTreeText('wait(seconds=0)', { handlers: {} });
    const absent = parseTreeText('wait(seconds=0)', { subtrees: undefined });
    type General = Expect<Equal<typeof withOptions, SubtreeDocument>>;
    type Optional = Expect<Equal<typeof maybeOptions, SubtreeDocument>>;
    type Registered = Expect<Equal<typeof registered, SubtreeDocument>>;
    type Ordinary = Expect<Equal<typeof ordinary, TreeDocument>>;
    type Handlers = Expect<Equal<typeof handlers, TreeDocument>>;
    type Absent = Expect<Equal<typeof absent, TreeDocument>>;
    // @ts-expect-error unresolved references require the subtree-aware consumer
    const unsafe: TreeDocument = withOptions;
  `;
  try {
    const file = join(folder, 'consumer.mts');
    writeFileSync(file, source);
    writeFileSync(
      join(folder, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          target: 'ESNext',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: [],
        },
        files: [file],
      }),
    );
    const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')));
    const result = spawnSync(process.execPath, [compiler, '-p', join(folder, 'tsconfig.json')], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
