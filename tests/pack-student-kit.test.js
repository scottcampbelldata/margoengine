import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIT_DOCUMENTS,
  KIT_FOLDER,
  KIT_MODELS,
  REDISTRIBUTABLE,
  isGuide,
  noticeText,
  packStudentKit,
  referencedModels,
  unzipEntries,
  zipEntries,
} from '../scripts/pack-student-kit.mjs';

const root = join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('every model the kit guides name has a redistributable licence on record, matching examples/assets/ATTRIBUTION.md', () => {
  const models = referencedModels(KIT_DOCUMENTS.filter(isGuide).map(read));
  assert.ok(models.includes('flight-helmet.glb'), 'loading-gltf.md names the Flight Helmet');
  assert.ok(models.includes('robot-expressive.glb'), 'animation.md names RobotExpressive');
  const attribution = read('examples/assets/ATTRIBUTION.md');
  for (const file of models) {
    const model = KIT_MODELS[file];
    assert.ok(model, `${file}: add it to KIT_MODELS with its source and licence`);
    assert.ok(REDISTRIBUTABLE.has(model.licence), `${file}: ${model.licence}`);
    // The file's bullet, up to the next one.
    const line = attribution.split(/\r?\n(?=- )/).find((text) => text.startsWith(`- \`${file}\``));
    assert.ok(line, `${file} is in ATTRIBUTION.md`);
    assert.ok(line.includes(model.source.replace(/\/$/, '')), `${file}: the source matches ATTRIBUTION.md`);
    if (model.licence === 'CC0-1.0') assert.match(line, /CC0 1\.0/, `${file}: ATTRIBUTION.md says CC0 1.0`);
  }
});

test('the NOTICE names each model, its licence and its source, and refuses a model with no licence or a closed one', () => {
  const text = noticeText(['flight-helmet.glb', 'robot-expressive.glb']);
  for (const [file, model] of Object.entries(KIT_MODELS)) {
    assert.ok(text.includes(`examples/assets/${file}`), file);
    assert.ok(text.includes(model.licence) && text.includes(model.source), file);
  }
  assert.match(text, /Apache-2\.0/);
  assert.throws(() => noticeText(['unknown.glb']), /no licence recorded for examples\/assets\/unknown\.glb/);
  KIT_MODELS['closed.glb'] = { name: 'x', source: 'y', licence: 'CC-BY-NC-4.0', credit: '' };
  try {
    assert.throws(() => noticeText(['closed.glb']), /CC-BY-NC-4\.0, which the kit may not pass on/);
  } finally {
    delete KIT_MODELS['closed.glb'];
  }
});

test('a guide that names a new model is found, in any of the asset folders formats', () => {
  assert.deepEqual(
    referencedModels(['Copy `examples/assets/a.glb` and examples/assets/khronos/Box/b.gltf.', 'again examples/assets/a.glb']),
    ['a.glb', 'khronos/Box/b.gltf'],
  );
});

test('the zip round-trips: deflated text, stored binary, UTF-8 names, CRCs checked', () => {
  const random = Buffer.alloc(4096);
  for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) >>> 24;
  const entries = [
    { name: 'kit/README.md', data: Buffer.from('# Hello\n'.repeat(200)) },
    { name: 'kit/examples/assets/x.glb', data: random },
    { name: 'kit/notes/café.txt', data: Buffer.from('ok') },
  ];
  const zip = zipEntries(entries, { date: new Date(2026, 10, 11, 9, 30, 0) });
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.length < 1600 + random.length, 'text was deflated');
  const back = unzipEntries(zip);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) assert.ok(back[i].data.equals(entries[i].data), entries[i].name);
  const damaged = Buffer.from(zip);
  damaged[30 + 'kit/README.md'.length + 2] ^= 0xff; // inside the first entry's deflated body
  assert.throws(() => unzipEntries(damaged));
});

test('packStudentKit writes one folder with the packages, the guide models, the documents and the NOTICE', () => {
  const scratch = mkdtempSync(join(root, 'test-results', 'student-kit-test-'));
  try {
    const out = join(scratch, 'kit.zip');
    const summary = packStudentKit({
      build: false,
      out,
      scratch: join(scratch, 'packs'),
      pack: (folder) => {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'margoengine-core-1.0.0.tgz'), 'core');
        writeFileSync(join(folder, 'margoengine-1.0.0.tgz'), 'facade');
      },
    });
    assert.equal(summary.tarballs, 2);
    const names = unzipEntries(readFileSync(out)).map((entry) => entry.name);
    assert.ok(names.every((name) => name.startsWith(`${KIT_FOLDER}/`)), 'one top-level folder');
    for (const path of [
      ...KIT_DOCUMENTS,
      'NOTICE.md',
      'examples/assets/flight-helmet.glb',
      'examples/assets/robot-expressive.glb',
      'margo-packages/margoengine-1.0.0.tgz',
      'margo-packages/margoengine-core-1.0.0.tgz',
    ])
      assert.ok(names.includes(`${KIT_FOLDER}/${path}`), path);
    assert.equal(names.filter((name) => name.includes('/examples/assets/')).length, summary.models.length, 'no model the guides do not name');
    const helmet = unzipEntries(readFileSync(out)).find((entry) => entry.name.endsWith('flight-helmet.glb'));
    assert.equal(helmet.data.toString('latin1', 0, 4), 'glTF', 'the real model, not a Git LFS pointer');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
