import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { UNITY_SUPPORT_PAYLOADS } from '../dist/unity-support.generated.js';
import { createUnityImportSupportPackage } from '../dist/unity.js';

const sha = (data) => createHash('sha256').update(data).digest('hex');

test('embedded and delivered Unity support preserves every canonical source byte, including comments and layout', async () => {
  const root = fileURLToPath(new URL('../src/unity/', import.meta.url));
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  assert.deepEqual(UNITY_SUPPORT_PAYLOADS.map((file) => file.name).sort(), files.sort());
  const bundle = await createUnityImportSupportPackage();
  for (const { name, text } of UNITY_SUPPORT_PAYLOADS) {
    const source = await readFile(join(root, name));
    assert.deepEqual(Buffer.from(text, 'utf8'), source, `${name}: embedded bytes`);
    const delivered = bundle.entries.find((entry) => entry.name === `Packages/com.margo.mesh/${name}`);
    assert.ok(delivered, name);
    assert.deepEqual(Buffer.from(delivered.data), source, `${name}: delivered bytes`);
    const digest = bundle.manifest.files.find((entry) => entry.path === name);
    assert.equal(digest.bytes, source.length, name);
    assert.equal(digest.sha256, sha(source), name);
  }
});

test('Unity generator preserves interpolated, verbatim and raw strings without imposing a C# parser subset', async (t) => {
  const scratchRoot = fileURLToPath(new URL('../../../test-results/', import.meta.url));
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, 'unity-support-'));
  t.after(async () => {
    assert.equal(dirname(resolve(scratch)), resolve(scratchRoot), 'cleanup stays inside this worktree test-results');
    await rm(scratch, { recursive: true, force: true });
  });
  await mkdir(join(scratch, 'scripts'));
  await mkdir(join(scratch, 'src/unity/Editor'), { recursive: true });
  const generator = join(scratch, 'scripts/generate-unity-support.mjs');
  await copyFile(new URL('../scripts/generate-unity-support.js', import.meta.url), generator);
  const sample = [
    '// Readable generated support: UTF-8 caf\u00e9',
    '#if UNITY_EDITOR // retain directive comment',
    '/// <summary>Keep documentation.</summary>',
    'class Sample {',
    '    string Show(int count) => $"Count: {count}";',
    '    string Path = @"C:\\path ""quoted""";',
    '    string Raw = """quotes and // comment-like text""";',
    '    /* Preserve layout and block comments. */',
    '}',
    '#endif',
    '',
  ].join('\n');
  await writeFile(join(scratch, 'src/unity/Editor/Sample.cs'), sample);
  await promisify(execFile)(process.execPath, [generator], { timeout: 30_000, windowsHide: true });
  const output = await readFile(join(scratch, 'src/unity-support.generated.ts'), 'utf8');
  const payloads = JSON.parse(output.slice(output.indexOf(' = ') + 3).trim().slice(0, -1));
  assert.deepEqual(payloads, [{ name: 'Editor/Sample.cs', text: sample }]);
});
