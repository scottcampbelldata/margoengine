import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { Animator } from '../packages/animator/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

test('blending avoids redundant pose copies and keeps transition snapshots intact', async () => {
  const store = await TransformStore.create(32),
    engine = new Engine({ width: 256, height: 256, clientWidth: 256, clientHeight: 256 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const fixture = animatedTriangle();
  fixture.doc.animations.push({ ...structuredClone(fixture.doc.animations[0]), name: 'Idle', channels: [] });
  const model = new PBRModel(engine, new GLTFAsset(fixture.doc, fixture.buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, {
      states: {
        moving: {
          parameter: 'speed',
          samples: [
            { value: 0, clip: 'Idle' },
            { value: 1, clip: 'Move' },
          ],
        },
        idle: 'Idle',
      },
      initial: 'moving',
      parameters: { speed: 0.5 },
    });
  try {
    let copies = 0;
    const slice = Array.prototype.slice;
    try {
      Array.prototype.slice = function (...args) {
        if ((this.length === 3 || this.length === 4) && this.every(Number.isFinite)) copies++;
        return slice.apply(this, args);
      };
      animator.onPreUpdate(0.5);
    } finally {
      Array.prototype.slice = slice;
    }
    assert.equal(copies, 6 * model.nodes.length, 'Only the two independent clip samples need vector copies');
    assert.equal(model.nodes[1].position.x, Math.fround(0.1));
    assert.equal(model.nodes[0].position.x, 0);
    animator.transition('idle', 1);
    for (const expected of [0.075, 0.05, 0.025, 0]) {
      animator.onPreUpdate(0.25);
      assert.ok(Math.abs(model.nodes[1].position.x - expected) < 1e-7);
    }
    animator.transition('moving', 0);
    animator.onPreUpdate(0.5);
    assert.equal(model.nodes[1].position.x, Math.fround(0.1));
    animator.transition('idle', 1);
    animator.onPreUpdate(0.25);
    animator.transition('moving', 1);
    animator.onPreUpdate(0.25);
    assert.ok(Math.abs(model.nodes[1].position.x - 0.06875) < 1e-7);
  } finally {
    animator.dispose();
    model.dispose();
    engine.dispose();
  }
});
