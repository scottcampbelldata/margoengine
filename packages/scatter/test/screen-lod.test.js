// KB-BIOMES-SCREENLOD1: screen-space rings compile only with lodSize; the WebGL2 candidate kernel and ScatterTiles take them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '@margoengine/core';
import { Scatter, scatterCullShader, screenRingCode } from '../dist/index.js';
import { compatChunk } from '../../../tests/support/compat-chunk.js';
import { tilesCullShader } from '../dist/tiles.js';

test('screen rings: off leaves the cull text, on picks rings by at = min(lod, scale * pixel.yz)', () => {
  const off = scatterCullShader({}),
    on = scatterCullShader({ lodSize: [0.1, 0.3] });
  assert.ok(!off.includes('let at='));
  assert.ok(on.includes('let at=min(frame.lod.xy,scale*frame.pixel.yz);'));
  assert.ok(on.includes('emit(select(select(2u,1u,d<at.y),0u,d<at.x),instance);'));
  assert.ok(!on.includes('frame.lod[ring]'));
  assert.equal(screenRingCode(off), on);
  assert.throws(() => screenRingCode(on), /written for/);
});

test('screen rings: the candidate kernel (WebGL2 route) and ScatterTiles carry them', async () => {
  const { candidateShader } = await compatChunk(new URL('../dist/', import.meta.url), 'candidateShader');
  const kernel = candidateShader(scatterCullShader({ lodSize: [0.1, 0.3] }));
  assert.ok(kernel.includes('return 1u<<select(select(2u,1u,d<at.y),0u,d<at.x);'));
  assert.ok(candidateShader(scatterCullShader({})).includes('d<frame.lod.y),0u,d<frame.lod.x)'));
  assert.ok(tilesCullShader(true).includes('let at=') && !tilesCullShader().includes('let at='));
  candidateShader(tilesCullShader(true));
});

test('screen rings: lodSize and lodPixels are validated', () => {
  for (const bad of [{ lodSize: [0.3, 0.1] }, { lodSize: [0, 1] }, { lodSize: [1] }, { lodPixels: 0 }, { lodPixels: 65 }])
    assert.throws(() => new Scatter(box(), bad), /lodSize/);
});
