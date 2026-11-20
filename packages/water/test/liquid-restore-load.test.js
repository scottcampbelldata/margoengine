import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticleLiquid } from '../dist/liquid.js';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';

// Found by the owner/lifetime fixture: the narrow band and whitewater were built when their lazy import settled, on
// the device of the frame that started the import. A device lost and restored in between left them on the dead device.
test('a device restore while the narrow band and whitewater load builds them on the new device', async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const host = await adapter.create(), { engine } = host;
    const liquid = ParticleLiquid.attach(engine, {
      particles: { positions: new Float32Array([0, 0, 0, 0.1, 0, 0]), velocities: new Float32Array(6) },
      radius: 0.05, narrowBand: true, whitewater: {},
    });
    const views = [{ camera: engine.camera, viewport: [0, 0, 64, 32], pixels: true }];
    const old = engine.gpu, late = [];
    let lost = false;
    for (const method of ['createBuffer', 'createTexture']) {
      const make = old[method];
      old[method] = function (...args) {
        if (lost) late.push(method);
        return make.apply(this, args);
      };
    }
    await host.render(views);
    lost = true;
    await host.lose({ lost() {}, watchDevice() {} });
    await liquid.ready();
    assert.notEqual(engine.gpu, old, 'the device was replaced');
    const made = [], device = engine.gpu, make = device.createBuffer;
    device.createBuffer = function (...args) {
      made.push(args[0].size);
      return make.apply(this, args);
    };
    await host.render(views);
    assert.deepEqual(late, [], 'nothing is made on the lost device');
    assert.ok(made.includes(32), 'the narrow band is built on the new device in the next frame');
    liquid.dispose();
    engine.dispose();
  } finally {
    adapter.close();
  }
});

// The in-frame build above must not make readWhitewater need a second frame: after the first frame it waits for the
// code and makes the pool on the current device (the whitewater GPU check reads it so).
test('readWhitewater after the first frame needs no second frame', async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const host = await adapter.create(), { engine } = host;
    const liquid = ParticleLiquid.attach(engine, {
      particles: { positions: new Float32Array([0, 0, 0, 0.1, 0, 0]), velocities: new Float32Array(6) },
      radius: 0.05, whitewater: {},
    });
    await host.render([{ camera: engine.camera, viewport: [0, 0, 64, 32], pixels: true }]);
    assert.deepEqual(await liquid.readWhitewater(), { spray: 0, foam: 0, bubbles: 0 });
    liquid.dispose();
    engine.dispose();
  } finally {
    adapter.close();
  }
});

// KB-RESTORE-BORROWED1: GPU particle buffers given as `(device) => buffer` come back on the restored device, and the
// whitewater reads the velocities made for it, not the lost device's.
test('particle buffers given as functions are made again for the restored device and feed the whitewater', async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const host = await adapter.create(), { engine } = host;
    const made = [];
    const buffer = (name) => (device) => {
      const b = device.createBuffer({ size: 64, usage: 128 | 8 });
      made.push([name, device, b]);
      return b;
    };
    const liquid = ParticleLiquid.attach(engine, {
      particles: { positions: buffer('positions'), velocities: buffer('velocities'), count: 4 },
      radius: 0.05, whitewater: {},
    });
    const views = [{ camera: engine.camera, viewport: [0, 0, 64, 32], pixels: true }];
    await host.render(views);
    await liquid.ready();
    await host.render(views);
    await host.lose({ lost() {}, watchDevice() {} });
    await host.render(views);
    await liquid.ready();
    await host.render(views);
    for (const name of ['positions', 'velocities']) {
      const devices = made.filter((row) => row[0] === name).map((row) => row[1]);
      assert.deepEqual(devices, [devices[0], engine.gpu], `${name} made once per device`);
      assert.notEqual(devices[0], engine.gpu);
    }
    liquid.dispose();
    engine.dispose();
  } finally {
    adapter.close();
  }
});
