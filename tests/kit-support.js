import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { KITS, KIT_MEMBERS } from '../scripts/umbrella.mjs';
import { importsOf, packageOf } from '../scripts/publish-rehearsal.mjs';

const root = new URL('../', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

export async function checkKit(name, entry) {
  const manifest = json(`packages/${name}/package.json`);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), KIT_MEMBERS[name].map((s) => `@margoengine/${s}`).sort());
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const path = `packages/${name}/${target.import.slice(2)}`;
    for (const specifier of importsOf(readFileSync(new URL(path, root), 'utf8'))) {
      const dependency = packageOf(specifier);
      if (dependency) assert.ok(manifest.dependencies[dependency], `${path}: undeclared ${dependency}`);
    }
    if (subpath === '.') continue;
    const source = `@margoengine${subpath.slice(1)}`;
    const [a, b] = await Promise.all([import(manifest.name + subpath.slice(1)), import(source)]);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), source);
    for (const key of Object.keys(b)) assert.equal(a[key], b[key], `${source} ${key}`);
  }
  if (name === 'react-kit') {
    assert.equal(typeof entry.Canvas, 'function');
    assert.equal('Voxel' in entry, false, 'the web root must not advertise a renderer outside its installed profile');
    assert.equal('XR' in entry, false);
  }
  else {
    for (const [source, names] of KITS[name].from) {
      const original = await import(source);
      for (const binding of names) assert.equal(entry[binding], original[binding], binding);
    }
    assert.equal(entry.createStage, (await import('@margoengine/stage')).createStage);
  }
  // A model-free application must not even emit a decoder asset. Separate loader entries keep
  // Vite's asset discovery away from the root, before its tree-shaker has run.
  if (name !== 'react-kit') {
    const out = await bundle(`export { createStage } from '${manifest.name}';`);
    assert.ok(out.every((file) => !/wasm|draco|basis/i.test(file.fileName)), manifest.name);
    const direct = await bundle("export { createStage } from '@margoengine/stage';");
    const bytes = (files) => {
      const byName = new Map(files.filter((f) => f.type === 'chunk').map((f) => [f.fileName, f]));
      const startup = [], queue = files.filter((f) => f.type === 'chunk' && f.isEntry);
      for (const chunk of queue) if (!startup.includes(chunk)) {
        startup.push(chunk);
        queue.push(...chunk.imports.map((file) => byName.get(file)).filter(Boolean));
      }
      return gzipSync(startup.map((f) => f.code).join('\n')).length;
    };
    assert.ok(Math.abs(bytes(out) - bytes(direct)) <= 64, 'unused kit exports add no engine code');
  }
}

async function bundle(code) {
  const out = await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    build: { write: false, target: 'es2022', rollupOptions: { input: 'kit-app', preserveEntrySignatures: 'strict' } },
    plugins: [{ name: 'kit-app', resolveId: (id) => id === 'kit-app' ? id : null, load: (id) => id === 'kit-app' ? code : null }],
  });
  return out.output;
}
