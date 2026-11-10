import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';

test('receiver membership follows add, remover and dispose without attaching another effect', () => {
  const lights = new Clustered(),
    receiver = {
      count: 0,
      addLighting() {
        this.count++;
        return () => this.count--;
      },
    };
  assert.equal(lights.hasReceiver(receiver), false);
  const remove = lights.add(receiver);
  assert.equal(lights.hasReceiver(receiver), true);
  remove();
  remove();
  assert.equal(lights.hasReceiver(receiver), false);
  lights.add(receiver);
  lights.dispose();
  assert.equal(lights.hasReceiver(receiver), false);
  assert.equal(receiver.count, 0);
});
