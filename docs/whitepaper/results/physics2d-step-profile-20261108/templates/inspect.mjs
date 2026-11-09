import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import binaryen from 'binaryen';
const root = '.lane/p/current-step-profile-v1';
const manifest = JSON.parse(readFileSync(root + '/manifest.json'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const artifacts = [];
for (const a of manifest.artifactPaths) {
  const bytes = readFileSync(a.file), file = root + '/measured-' + a.name + '.wasm';
  assert.ok(!existsSync(file), 'Immutable snapshot already exists');
  copyFileSync(a.file, file);
  const module = binaryen.readBinary(bytes), wat = module.emitText();
  module.dispose();
  writeFileSync(root + '/' + a.name + '.wat', wat);
  const cal = /\(export "profile_calibrate" \(func (\$[^)]+)\)\)/.exec(wat)?.[1];
  assert.ok(cal);
  const functions = [...wat.matchAll(/^ \(func (\$\S+)/gm)];
  const i = functions.findIndex((m) => m[1] === cal);
  assert.ok(i >= 0);
  const text = wat.slice(functions[i].index, functions[i + 1]?.index ?? wat.length);
  const importName = /\(import "env" "probe_now" \(func (\$[^\s()]+)/.exec(wat)?.[1];
  const loops = (text.match(/\(loop\b/g) ?? []).length;
  if (a.name === 'instrumented') {
    assert.ok(importName);
    assert.ok(text.includes('(call ' + importName));
    assert.ok(loops >= 2, 'Imported-clock and observable empty calibration loops must both remain');
  }
  artifacts.push({ name: a.name, original: a.file, file, sha256: hash(bytes), bytes: bytes.length, calibration: { exportFunction: cal, importName, loopCount: loops, wat: text } });
}
writeFileSync(root + '/artifacts.json', JSON.stringify({ artifacts, sourceManifestSha256: hash(readFileSync(root + '/manifest.json')), inspection: 'Binaryen readBinary/emitText only; no optimize or rewrite; both calibration loops retained in instrumented export.' }, null, 2) + '\n');
console.log(JSON.stringify(artifacts.map(({ calibration, ...a }) => ({ ...a, calibrationLoops: calibration.loopCount })), null, 2));
