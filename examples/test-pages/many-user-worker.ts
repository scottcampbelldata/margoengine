import { receiveCanvas } from '@margoengine/worker/canvas';
import { Engine, box, PbrMaterial } from '@margoengine/core';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';

async function main() {
  try {
    const received = await receiveCanvas({ timeout: 10000 });
    const { canvas, data } = received;
    const backend = (data as { backend?: string })?.backend ?? 'auto';
    const engine = await Engine.create(canvas, {
      backend: backend === 'webgl2' ? 'webgl2' : 'auto',
      fallback: webglRenderer,
      camera: { position: [0, 2, 4], target: [0, 0, 0] },
    });
    received.attach(engine);

    const cube = engine
      .createMesh()
      .setGeometry(box(1.2, 1.2, 1.2))
      .setMaterial(new PbrMaterial({ color: '#38bdf8', roughness: 0.3, metalness: 0.2 }));

    engine.onFrame((_, delta) => {
      cube.rotation.x += delta * 0.8;
      cube.rotation.y += delta * 1.2;
    });

    engine.start();
  } catch (err) {
    console.error('Worker canvas error:', err);
  }
}

main();
