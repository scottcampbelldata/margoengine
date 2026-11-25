// The /main and /loaders entries split the root (KB-REACT-ENVDECODERS1): /main holds everything but the image decoders,
// /loaders holds the decoders, and the root re-exports both, so an app that reads no environment file can import /main
// and bundle none of the HDR, EXR and UltraHDR decoders.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as root from '@margoengine/environment';
import * as loaders from '@margoengine/environment/loaders';
import * as main from '@margoengine/environment/main';

const decoders = ['parseEXR', 'parseEnvironmentImage', 'loadEnvironmentImage'];

test('/loaders holds the image decoders and /main holds none of them', () => {
  for (const name of decoders) {
    assert.equal(typeof loaders[name], 'function', `/loaders exports ${name}`);
    assert.equal(name in main, false, `/main must not export ${name}`);
  }
});

test('the root re-exports /main and /loaders as the same objects, and nothing else', () => {
  for (const [name, value] of Object.entries(main)) assert.equal(root[name], value, `root ${name} is /main's`);
  for (const [name, value] of Object.entries(loaders)) assert.equal(root[name], value, `root ${name} is /loaders'`);
  const split = new Set([...Object.keys(main), ...Object.keys(loaders)]);
  assert.deepEqual(
    Object.keys(root).filter((name) => !split.has(name)),
    [],
    'every root export comes from /main or /loaders',
  );
});
