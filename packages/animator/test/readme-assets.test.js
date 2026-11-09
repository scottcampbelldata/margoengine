import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseSync } from 'rolldown/utils';
import { readmeEntries } from '../../../scripts/support/readme-types.mjs';

const assets = new Map([
  ['UAL1_Standard_RM.glb', 'examples/assets/quaternius/UAL1_Standard_RM.glb'],
  [
    'Rig_Medium_MovementBasic.glb',
    'examples/assets/kaykit/adventurers/animations/Rig_Medium/Rig_Medium_MovementBasic.glb',
  ],
]);
const root = new URL('../../../', import.meta.url);
const entries = readmeEntries(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
for (const { code, heading } of entries)
  test(`README ${heading} names real model clips and joints`, () => {
    const path = /loadGLTF\(engine,\s*'([^']+\.glb)'/.exec(code)?.[1];
    assert.ok(path, 'standalone example loads its required model');
    const file = assets.get(basename(path));
    assert.ok(file, `example must use its documented bundled model: ${path}`);
    const bytes = readFileSync(new URL(file, root));
    const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
    const nodes = new Set(doc.nodes.map((n) => n.name));
    const clips = new Set(doc.animations.map((a) => a.name));
    function states(node) {
      if (node.type !== 'ObjectExpression') return;
      for (const p of node.properties)
        if (p.value?.type === 'Literal' && typeof p.value.value === 'string')
          assert.ok(clips.has(p.value.value), `missing state clip ${p.value.value}`);
    }
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && ['joint', 'node'].includes(node.callee.name)) {
        const name = node.arguments[0];
        if (name?.type === 'Literal') assert.ok(nodes.has(name.value), `missing joint ${name.value}`);
      }
      if (node.type === 'Property') {
        const key = node.key.name ?? node.key.value;
        if (key === 'states') states(node.value);
        if (key === 'clipMarkers')
          for (const p of node.value.properties)
            assert.ok(clips.has(p.key.name ?? p.key.value), `missing marker clip ${p.key.name ?? p.key.value}`);
        if (key === 'clip' && node.value.type === 'Literal')
          assert.ok(clips.has(node.value.value), `missing tree/layer clip ${node.value.value}`);
      }
      for (const value of Object.values(node))
        if (Array.isArray(value)) {
          for (const child of value) visit(child);
        } else if (value && typeof value === 'object') visit(value);
    }
    visit(parseSync('example.ts', code).program);
  });
