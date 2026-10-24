import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exportDAE, exportUSDZ } from '@margoengine/exporters';

test('USDZ subpath preserves root identity and loads only its serializer', async () => {
  const isolated = await import('@margoengine/exporters/usdz');
  assert.deepEqual(Object.keys(isolated), ['exportUSDZ']);
  assert.equal(isolated.exportUSDZ, exportUSDZ);
  const entry = await readFile(new URL('../dist/usdz.js', import.meta.url), 'utf8');
  assert.match(entry, /from ['"]\.\/scene\.js['"]/);
  assert.doesNotMatch(entry, /from ['"]\.\/(?:index|gltf|stl|obj|ply)\.js['"]/);
});

test('DAE subpath preserves root identity and loads only its serializer', async () => {
  const isolated = await import('@margoengine/exporters/dae');
  assert.deepEqual(Object.keys(isolated), ['exportDAE']);
  assert.equal(isolated.exportDAE, exportDAE);
  const entry = await readFile(new URL('../dist/dae.js', import.meta.url), 'utf8');
  assert.match(entry, /from ['"]\.\/scene\.js['"]/);
  assert.doesNotMatch(entry, /from ['"]\.\/(?:index|gltf|stl|obj|ply|usdz)\.js['"]/);
});

test('Godot delivery subpath exposes only its pure generator and does not import renderer or format writers', async () => {
  const isolated = await import('@margoengine/exporters/godot');
  assert.deepEqual(Object.keys(isolated), ['createGodotImportBundle']);
  const entry = await readFile(new URL('../dist/godot.js', import.meta.url), 'utf8');
  assert.match(entry, /from ['"]\.\/glb\.js['"]/);
  assert.doesNotMatch(entry, /from ['"]\.\/(?:index|gltf|capture|model|scene)\.js['"]/);
  assert.doesNotMatch(entry, /from ['"]node:|(?:globalThis|window)\.(?:document|navigator)|requestAdapter\(/);
});

test('Godot add-on subpath exposes only the add-on generator, apart from the import bundle', async () => {
  const isolated = await import('@margoengine/exporters/godot-addon');
  assert.deepEqual(Object.keys(isolated), ['createGodotImportAddon']);
  const entry = await readFile(new URL('../dist/godot-addon.js', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /from ['"]\.\/(?:index|gltf|glb|godot|capture|model|scene)\.js['"]/);
});

test('Unity delivery subpath exposes only file generators and never loads a renderer or native launcher', async () => {
  const isolated = await import('@margoengine/exporters/unity');
  assert.deepEqual(Object.keys(isolated), ['createUnityImportBundle', 'createUnityImportSupportPackage']);
  const entry = await readFile(new URL('../dist/unity.js', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /from ['"]\.\/(?:index|gltf|capture|model|scene)\.js['"]/);
  assert.doesNotMatch(entry, /from ['"]node:|requestAdapter\(|child_process|writeFile\(/);
});
