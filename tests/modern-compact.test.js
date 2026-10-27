import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compactInternals } from '../scripts/compact-internals.js';
import { compactOutput } from '../scripts/measure-size.js';
import { minifySync } from 'rolldown/utils';
import { wgsl } from '../packages/core/dist/shaders.js';

test('library compaction preserves public members and foreign this bindings', () => {
  const source =
    'class Mesh { private current = 1; private receives = 0; public value() { return [this.current, this.current, this.receives]; } }';
  const output = compactInternals(
    source,
    `class Mesh {
 current = 1;
 receives = 0;
 value() { return [this.current, () => this.current, function() { return this.current; }, {run() { return this.current; }}]; }
 }`,
  );
  assert.ok(output.includes('e = 1'));
  assert.ok(output.includes('f = 0'));
  assert.ok(
    output.includes('[this.e, () => this.e, function() { return this.current; }, {run() { return this.current; }}]'),
  );
  assert.throws(() => compactInternals(source, 'class Mesh { e = 2; current = 1; }'), /collides/);
  assert.throws(
    () => compactInternals(source, 'class Mesh { current = 1; get() { return this["current"]; } }'),
    /computed/,
  );
  assert.throws(
    () => compactInternals(source.replace('private current', 'public current'), 'class Mesh {}'),
    /Review Mesh.current/,
  );
});

test('production compaction drops debugger and preserves public exports', () => {
  const { code } = minifySync(
    'smoke.js',
    'export function publicName(longArgument) { debugger; return longArgument; }',
    { module: true, ...compactOutput.minify },
  );
  assert.doesNotMatch(code, /debugger|longArgument/);
  assert.match(code, /publicName/);
});

test('compaction preserves private defaults and lexical parameter initializers', () => {
  const source =
    'class Mesh { private current = 7; private receives = 0; read(value = this.current, lazy = () => this.current) { return [value, lazy()]; } }';
  const output = compactInternals(source, source.replaceAll('private ', ''));
  const instance = new (Function(`${output}; return Mesh;`)())();
  assert.deepEqual(instance.read(), [7, 7]);
});

test('extended private aliases reject collisions with public uppercase members', async () => {
  const source = await readFile(new URL('../packages/core/src/renderer.ts', import.meta.url), 'utf8');
  assert.throws(() => compactInternals(source, 'class GPURenderer { A = 1; }'), /Internal alias A collides/);
});

test('compacted WGSL preserves the optional shader injection boundaries', () => {
  for (const token of [
    'o.clip=frame.camera*p',
    '@location(3) material:vec4f',
    'o.color=i.color.rgb;',
    'let p=model*vec4f(i.position,1);',
    'let facing=',
    'frame.radiance.w',
    'let n=normalize(i.normal)',
    '@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f',
    '->@location(0) vec4f {',
  ])
    assert.ok(wgsl.includes(token), token);
  for (const pattern of [
    /struct Frame \{[^}]+\}/,
    /struct Input \{[^}]+\}/,
    /struct Output \{[^}]+\}/,
    /@vertex fn vertex\([\s\S]*?(?=@fragment)/,
    /(@fragment fn fragment[^{]+\{)/,
    /let linear=([^;]+);/,
    /let mapped=pbrNeutral\([\s\S]*?return vec4f\([^\n]+\);/,
    /let direct=[\s\S]*return vec4f\([^\n]+\);/,
    /let v=normalize\(frame.eye.xyz-i.position\);[\s\S]*?let linear=[^;]+;/,
    /let n=normalize\(i.normal\)[\s\S]*$/,
  ])
    assert.match(wgsl, pattern);
});
