import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test('build version generation preserves an equivalent CRLF checkout without dirtying it', async () => {
  const root = resolve(`test-results/sciviz-provenance/versions-${process.pid}`);
  const scripts = resolve(root, 'sciviz/scripts'),
    source = resolve(root, 'sciviz/src');
  await mkdir(scripts, { recursive: true });
  await mkdir(source, { recursive: true });
  await mkdir(resolve(root, 'core'), { recursive: true });
  await writeFile(
    resolve(root, 'sciviz/package.json'),
    JSON.stringify({
      name: '@margoengine/sciviz',
      version: '1.0.0',
      type: 'module',
      dependencies: { '@margoengine/core': '^1.0.0' },
    }),
  );
  await writeFile(
    resolve(root, 'core/package.json'),
    JSON.stringify({ name: '@margoengine/core', version: '1.0.0', type: 'module' }),
  );
  const script = resolve(scripts, 'write-provenance-versions.mjs');
  await copyFile(new URL('../scripts/write-provenance-versions.mjs', import.meta.url), script);
  execFileSync(process.execPath, [script], { timeout: 10000, windowsHide: true });
  const output = resolve(source, 'provenance-versions.ts');
  const crlf = (await readFile(output, 'utf8')).replace(/\n/g, '\r\n');
  await writeFile(output, crlf);
  execFileSync(process.execPath, [script], { timeout: 10000, windowsHide: true });
  assert.equal(await readFile(output, 'utf8'), crlf);
  assert.match(crlf, /"@margoengine\/core": "1.0.0"/);
});
