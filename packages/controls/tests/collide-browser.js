import { Engine, box, PbrMaterial } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { OrbitControls } from '@margoengine/controls/collide';
export async function check() {
  const rows = [],
    errors = [];
  for (const backend of ['webgpu', 'webgl2']) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    canvas.style.width = canvas.style.height = '128px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend,
      fallback: backend === 'webgl2' ? webglRenderer : undefined,
      camera: { position: [0, 0, 10], target: [0, 0, 0], near: 0.1, far: 100 },
    });
    const device = backend === 'webgpu' ? engineRuntime(engine).gpu : null;
    device?.pushErrorScope('validation');
    const subject = engine
      .createMesh()
      .setGeometry(box())
      .setMaterial(new PbrMaterial({ color: '#ffffff', unlit: true }));
    const wall = engine
      .createMesh()
      .setGeometry(box())
      .setScale([10, 10, 0.2])
      .setPosition([0, 0, 3])
      .setMaterial(new PbrMaterial({ color: '#ff0000', unlit: true }));
    const control = new OrbitControls(engine, { colliders: [wall], returnTime: 0 });
    const read = async () => {
      const image = await createImageBitmap(canvas),
        flat = new OffscreenCanvas(128, 128).getContext('2d');
      flat.drawImage(image, 0, 0);
      image.close();
      const pixels = flat.getImageData(0, 0, 128, 128).data;
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] > 100 && pixels[i + 1] > 100 && pixels[i + 2] > 100) white++;
      return white;
    };
    try {
      engine.render({ delta: 0 });
      const shortened = control.armLength,
        visible = await read();
      if (!(shortened < 2.9 && shortened > 2.8 && visible > 1000))
        throw new Error(`Orbit wall collision ${shortened}, ${visible} white pixels`);
      wall.setPosition([20, 0, 3]);
      engine.render({ delta: 0 });
      const restored = control.armLength,
        farVisible = await read();
      if (Math.abs(restored - 10) > 1e-8 || farVisible < 100)
        throw new Error(`Orbit did not restore ${restored}, ${farVisible}`);
      if (device) {
        await device.queue.onSubmittedWorkDone();
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
      }
      rows.push({ backend: engine.backend, shortened, restored, visible, farVisible, rays: control.rays });
    } finally {
      control.dispose();
      subject.dispose();
      wall.dispose();
      engine.dispose();
      canvas.remove();
    }
  }
  return { rows, errors };
}
