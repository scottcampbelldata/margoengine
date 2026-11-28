import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PbrMaterial, UnlitMaterial } from '@margoengine/materials';
import { captureMaterials, restoreMaterials } from '../dist/materials.js';

const json = (v) => JSON.parse(JSON.stringify(v));

// restoreMaterials returned Record<string, object>, so every caller cast the result to the class it saved.
test('expect types each named material, so a restored library needs no cast', { timeout: 30000 }, () => {
  const results = fileURLToPath(new URL('../../../test-results/', import.meta.url));
  mkdirSync(results, { recursive: true });
  const folder = mkdtempSync(join(results, 'save-material-types-'));
  const path = (url) => JSON.stringify(fileURLToPath(new URL(url, import.meta.url)).replaceAll('\\', '/'));
  const source = `
    import { PbrMaterial, UnlitMaterial } from ${path('../../materials/dist/index.js')};
    import { captureMaterials, restoreMaterials } from ${path('../dist/materials.js')};
    const library = await captureMaterials({ red: new PbrMaterial(), flat: new UnlitMaterial() });
    const restored = await restoreMaterials(library, { expect: { red: PbrMaterial, flat: UnlitMaterial } });
    const roughness: number = restored.red.roughness;
    const flat: UnlitMaterial = restored.flat;
    const other: object = restored.anything;
    // @ts-expect-error expect takes classes
    void restoreMaterials(library, { expect: { red: 5 } });
    const plain = await restoreMaterials(library);
    // @ts-expect-error without expect a result is only an object
    plain.red.roughness;
    void [roughness, flat, other];
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
          lib: ['ESNext', 'DOM'],
        },
        files: [file],
      }),
    );
    const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')));
    const result = spawnSync(process.execPath, [compiler, '-p', join(folder, 'tsconfig.json')], {
      encoding: 'utf8',
      timeout: 25000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('expect checks each class at run time and disposes the restore when one is wrong or missing', async () => {
  const disposed = [];
  const probe = {
    type: 'probe',
    test: (value) => value instanceof Probe,
    capture: () => ({}),
    restore: () => {
      const made = new Probe();
      made.dispose = () => disposed.push(made);
      return made;
    },
  };
  class Probe {}
  const library = json(
    await captureMaterials({ red: new PbrMaterial({ roughness: 0.4 }), probe: new Probe() }, { codecs: [probe] }),
  );
  const restored = await restoreMaterials(library, { codecs: [probe], expect: { red: PbrMaterial } });
  assert.ok(restored.red instanceof PbrMaterial);
  assert.equal(restored.red.roughness, 0.4);
  assert.ok(restored.probe instanceof Probe);
  assert.deepEqual(disposed, []);

  await assert.rejects(() => restoreMaterials(library, { codecs: [probe], expect: { red: UnlitMaterial } }), {
    code: 'state',
    message: /Material "red" is not UnlitMaterial/,
  });
  assert.equal(disposed.length, 1);
  await assert.rejects(() => restoreMaterials(library, { codecs: [probe], expect: { blue: PbrMaterial } }), {
    code: 'state',
    message: /Material "blue" is missing/,
  });
  assert.equal(disposed.length, 2);
});
