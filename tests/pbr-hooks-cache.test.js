import test from 'node:test';
import assert from 'node:assert/strict';
import { lightPBR } from '../packages/shared/pbr-hooks.js';
import { pbrShader, physicalShader } from '../packages/gltf-pro/src/shader.ts';

test('lighting cache hits preserve empty results and bypass hook getters and callbacks', () => {
  let reads = 0;
  const empty = {
    get declarations() {
      reads++;
      return '';
    },
  };
  assert.equal(lightPBR('', empty), '');
  assert.equal(lightPBR('', empty), '');
  assert.equal(reads, 1);

  const events = [];
  const hooks = new Proxy(
    {
      declarations: '// effect\n',
      direct(value) {
        events.push(['direct', this === hooks, value]);
        return `shade(${value})`;
      },
      light: 'localLight(i,s,v)',
      ambient: 'ambientLight(i,s,v)',
      output(value) {
        events.push(['output', this === hooks, value]);
        return `finish(${value})`;
      },
    },
    {
      get(target, property, receiver) {
        events.push(['get', property]);
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const first = lightPBR(pbrShader, hooks);
  const beforeHit = events.slice();
  assert.match(first, /shade\(direct\)\+ambient\(s\)/);
  assert.match(first, /var color=localLight\(i,s,v\)\+/);
  assert.match(first, /let margoAmbient=ambientLight\(i,s,v\);/);
  assert.equal(events.find((event) => event[0] === 'direct')[1], true);
  assert.equal(events.find((event) => event[0] === 'output')[1], true);
  assert.equal(lightPBR(pbrShader, hooks), first);
  assert.deepEqual(events, beforeHit);
});

test('lighting failures do not cache partial composition and retry the same hook object', () => {
  let calls = 0;
  const hooks = {
    declarations: '// retry\n',
    direct(value) {
      calls++;
      return `shadow(${value})`;
    },
    output() {
      throw new Error('output failed');
    },
  };
  assert.throws(() => lightPBR(pbrShader, hooks), /output failed/);
  assert.equal(calls, 1);
  hooks.output = (value) => `finish(${value})`;
  const result = lightPBR(pbrShader, hooks);
  assert.equal(calls, 2);
  assert.ok(result.startsWith('// retry\n'));
  assert.match(result, /shadow\(direct\)/);
  assert.equal(lightPBR(pbrShader, hooks), result);
  assert.equal(calls, 2);
});

test('lighting composition supports reentrant same-hook misses and retains both cached variants', () => {
  let nested = false;
  let calls = 0;
  let inner;
  const hooks = {
    declarations: '// reentrant\n',
    direct(value) {
      calls++;
      if (!nested) {
        nested = true;
        inner = lightPBR(physicalShader(), hooks);
      }
      return `shadow(${value})`;
    },
  };
  const outer = lightPBR(pbrShader, hooks);
  assert.match(outer, /shadow\(direct\)/);
  assert.match(inner, /shadow\(direct\)/);
  assert.equal(calls, 2);
  assert.equal(lightPBR(pbrShader, hooks), outer);
  // A miss that began without a cache keeps its own publication semantics under reentry.
  assert.equal(lightPBR(physicalShader(), hooks), inner);
  assert.equal(calls, 3);
  assert.equal(lightPBR(physicalShader(), hooks), inner);
  assert.equal(calls, 3);
});

test('lighting cache remains bounded while preserving recent shader variants and hook identity', () => {
  let calls = 0;
  const hooks = {
    declarations: '',
    direct(value) {
      calls++;
      return `shade(${value})`;
    },
  };
  const variants = Array.from({ length: 65 }, (_, index) => `// ${index}\n${pbrShader}`);
  const results = variants.map((source) => lightPBR(source, hooks));
  assert.equal(calls, 65);
  assert.equal(lightPBR(variants[64], hooks), results[64]);
  assert.equal(calls, 65);
  assert.equal(lightPBR(variants[0], hooks), results[0]);
  assert.equal(calls, 66);
  const other = { ...hooks };
  assert.equal(lightPBR(variants[0], other), results[0]);
  assert.equal(calls, 67);
});
