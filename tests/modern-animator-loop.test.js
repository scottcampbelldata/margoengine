import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { Animator } from '../packages/animator/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

test('nonlooping animator holds the final pose and crossfades from that pose after completion', async () => {
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
    animation = new Animation(model, { loop: false }),
    animator = new Animator(animation, { states: { moving: 'Move', idle: 'Idle' }, initial: 'moving' });
  try {
    animator.onPreUpdate(1);
    assert.equal(model.nodes[1].position.x, Math.fround(0.4));
    animator.onPreUpdate(3);
    assert.equal(model.nodes[1].position.x, Math.fround(0.4));
    animator.transition('idle', 1);
    animator.onPreUpdate(0.25);
    assert.ok(Math.abs(model.nodes[1].position.x - 0.3) < 1e-7, 'The transition must begin at the completed clip pose');
    animator.onPreUpdate(0.75);
    assert.equal(model.nodes[1].position.x, 0);
    animation.options.loop = true;
    animator.transition('moving', 0);
    animator.onPreUpdate(1);
    assert.equal(model.nodes[1].position.x, 0, 'Default loop behavior still wraps');
  } finally {
    animator.dispose();
    model.dispose();
    engine.dispose();
  }
});
