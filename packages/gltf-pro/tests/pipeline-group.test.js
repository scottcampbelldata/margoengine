import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pipelineGroup } from '../src/group.ts';

const fakeDevice = () => {
  const made = [];
  return {
    made,
    createBindGroupLayout: (descriptor) => ({ explicit: descriptor }),
    createBindGroup: (descriptor) => (made.push(descriptor), { descriptor }),
  };
};
const pipeline = {
  getBindGroupLayout() {
    throw new Error('an empty group must not ask the pipeline for its layout (WebKit answers with an invalid one)');
  },
};

test('an empty group never takes its layout from the pipeline, and one group serves a device', () => {
  const device = fakeDevice(),
    group = pipelineGroup(device, pipeline, 1, []);
  assert.equal(pipelineGroup(device, pipeline, 2, []), group);
  assert.equal(device.made.length, 1);
  assert.deepEqual(device.made[0].layout, { explicit: { entries: [] } });
  assert.notEqual(pipelineGroup(fakeDevice(), pipeline, 1, []), group);
});

test('a group with entries uses the layout of its index', () => {
  const device = fakeDevice(),
    entries = [{ binding: 0, resource: {} }],
    asked = [],
    group = pipelineGroup(device, { getBindGroupLayout: (i) => (asked.push(i), `layout ${i}`) }, 2, entries);
  assert.deepEqual(asked, [2]);
  assert.equal(group.descriptor.layout, 'layout 2');
  assert.equal(group.descriptor.entries, entries);
});

test('the renderer makes its possibly empty groups through pipelineGroup', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createBindGroup\(\{\s*layout: \w+!?\.getBindGroupLayout\([12]\)/);
});
