// Type-checks every ```ts block of a package README as a module of that package, all in one compiler run, so a package
// test can hold the README to "runs as written". Returns the compiler's lines; an empty list passes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));

/** The package folder of a test file two levels down. */
export const packageFolder = (url) => dirname(dirname(fileURLToPath(url)));

export function readmeTypeErrors(folder) {
  const blocks = [...readFileSync(join(folder, 'README.md'), 'utf8').matchAll(/```ts\r?\n([\s\S]*?)```/g)];
  if (!blocks.length) return [`${folder}/README.md has no ts examples`];
  // Inside the package, so its package.json makes the files modules and node_modules resolves as for a consumer.
  const scratch = mkdtempSync(join(resolve(folder), '.readme-check-'));
  try {
    blocks.forEach((block, i) => writeFileSync(join(scratch, `example-${i}.ts`), block[1]));
    writeFileSync(
      join(scratch, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'ESNext.Disposable', 'DOM'],
          skipLibCheck: true,
          types: [],
        },
        include: ['*.ts'],
      }),
    );
    const run = spawnSync(process.execPath, [compiler, '-p', scratch, '--pretty', 'false'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (run.error) throw run.error;
    return run.status === 0 ? [] : `${run.stdout}${run.stderr}`.split(/\r?\n/).filter(Boolean);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
