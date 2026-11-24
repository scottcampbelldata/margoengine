// Regression (KB-FF1b, 2026-11-11): every value-returning WGSL function must end in a return on every path. The spec's
// behavior analysis accepts a function whose last statement is a `loop` left only by `return`, but Firefox's WGSL front
// end does not; water's coastal.ts `root` was written that way and the biomes GPU suite failed only in Firefox (KB-FF1).
// The rule is checked on the source text by hygiene (scripts/support/wgsl-returns.mjs), on every builder output by
// check:wgsl and on every module a browser check creates by the WGSL guard (scripts/support/wgsl-guard.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { watchWgsl, wgslGuard, wgslReturnGaps } from '../scripts/support/wgsl-guard.js';
import { findWgslReturnGaps, writtenFunctions } from '../scripts/support/wgsl-returns.mjs';

const names = (code) => wgslReturnGaps(code).map((gap) => gap.name);

test('a function that ends in a loop left only by return is a gap (the KB-FF1 shape)', () => {
  assert.deepEqual(
    names(
      'fn root(index:u32)->u32 {\n var p=index;\n loop {let next=p;if(next==p){return p;}p=next;}\n}\nfn join(a:u32){ loop {} }',
    ),
    ['root'],
  );
  assert.deepEqual(names('fn root(index:u32)->u32 { var p=index; loop { if (p==0u) { break; } p=p-1u; } return p; }'), []);
});

test('if needs an else on every branch, switch needs every clause, for and while never end a function', () => {
  assert.deepEqual(names('fn a(x:f32)->f32 { if x>0. { return 1.; } else if (x<0.) { return -1.; } else { return 0.; } }'), []);
  assert.deepEqual(names('fn a(x:f32)->f32 { if x>0. { return 1.; } else if (x<0.) { return -1.; } }'), ['a']);
  assert.deepEqual(names('fn a(x:i32)->i32 { switch x { case 1, 2: { return 1; } default { return 0; } } }'), []);
  assert.deepEqual(names('fn a(x:i32)->i32 { switch (x) { case 1 { return 1; } case 2, default { } } }'), ['a']);
  assert.deepEqual(names('fn a()->f32 { for (var i=0;i<4;i++) { return 1.; } }'), ['a']);
  assert.deepEqual(names('fn a()->f32 { while true { return 1.; } }'), ['a']);
  assert.deepEqual(names('fn a()->f32 { { let x = array<f32,2>(1.,2.); return x[0]; } }'), []);
});

test('attributes, comments and void functions are read correctly', () => {
  assert.deepEqual(
    names(
      '@fragment fn fs(@location(0) c: vec4f) -> @location(0) vec4f {\n /* } */ if c.a < 0.5 { discard; }\n return c; // }\n}',
    ),
    [],
  );
  assert.deepEqual(names('fn v() { loop {} }\nfn w(x: f32) -> f32 { let y = x; }'), ['w']);
  assert.deepEqual(wgslReturnGaps('\n\nfn w(x: f32) -> f32 {\n let y = x;\n}'), [{ name: 'w', line: 3 }]);
});

test('the WGSL guard reports a gap in any module a browser check creates as an error', async () => {
  const lines = [],
    original = { debug: console.debug, error: console.error };
  console.debug = (text) => lines.push(text);
  console.error = (text) => lines.push(text);
  globalThis.GPUDevice = class {
    createShaderModule() {
      return { getCompilationInfo: async () => ({ messages: [] }) };
    }
  };
  try {
    wgslGuard();
    const device = new GPUDevice();
    device.createShaderModule({ code: 'fn r(i:u32)->u32 { loop { return i; } }', label: 'assembled' });
    device.createShaderModule({ code: 'fn r(i:u32)->u32 { return i; }', label: 'fine' });
    await Promise.all(globalThis.__margoWgslReports);
  } finally {
    Object.assign(console, original);
    delete globalThis.GPUDevice;
    delete globalThis.__margoWgslReports;
    delete globalThis.__margoWgslPending;
  }
  const listeners = [],
    watched = watchWgsl({ on: (_event, listener) => listeners.push(listener) });
  for (const text of lines) for (const listener of listeners) listener({ text: () => text });
  assert.equal(watched.errors.length, 1);
  assert.match(watched.errors[0], /^assembled 1:1 function 'r' returns a value but does not end in a return/);
});

test('the source scan finds gaps in .wgsl files and written-out functions, and skips assembled ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'wgsl-returns-'));
  try {
    mkdirSync(join(root, 'packages', 'pond', 'src'), { recursive: true });
    mkdirSync(join(root, 'packages', 'pond', 'shaders'), { recursive: true });
    mkdirSync(join(root, 'packages', 'shared'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'pond', 'src', 'a.ts'),
      'export const code = `\nfn root(i:u32)->u32 { loop { return i; } }\nfn piece(i:u32)->u32 { ${"loop { return i; }"} }\n`;\n',
    );
    writeFileSync(join(root, 'packages', 'pond', 'shaders', 'b.wgsl'), 'fn s(x: f32) -> f32 {\n if x > 0. { return x; }\n}\n');
    writeFileSync(join(root, 'packages', 'shared', 'c.js'), 'export const c = `fn t()->f32 { while true { return 1.; } }`;\n');
    const { gaps } = findWgslReturnGaps(root);
    assert.deepEqual(gaps.sort(), ['packages/pond/shaders/b.wgsl:1 s', 'packages/pond/src/a.ts:2 root', 'packages/shared/c.js:1 t']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(
    writtenFunctions('const a = `fn f()->u32 { ${x} }`;').map((f) => f.name),
    [],
    'a function built from pieces is left to check:wgsl and the guard',
  );
});

test('every shipped WGSL function in the repository returns on every path', () => {
  const { gaps, checked } = findWgslReturnGaps(resolve(import.meta.dirname, '..'));
  assert.ok(checked > 1000, `read ${checked} functions`);
  assert.deepEqual(gaps, []);
});
