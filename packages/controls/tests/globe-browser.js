import { Engine, PbrMaterial } from '@margoengine/core';
import { sphereGeometry, toGeometry } from '@margoengine/geometry';
import { engineRuntime } from '@margoengine/core/extension';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { GlobeControls } from '@margoengine/controls/globe';

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
      camera: { position: [0, 0, 7], target: [0, 0, 0], near: 0.01, far: 100 },
    });
    const device = backend === 'webgpu' ? engineRuntime(engine).gpu : null;
    device?.pushErrorScope('validation');
    const mesh = engine
      .createMesh()
      .setGeometry(toGeometry(sphereGeometry(1, 32, 16)))
      .setScale([2, 1.8, 2])
      .setMaterial(new PbrMaterial({ color: '#ffffff', unlit: true }));
    const control = new GlobeControls(engine, canvas, { radii: [2, 1.8, 2], minAltitude: 0.01 });
    try {
      const point = control.pick(64, 64);
      const rect = canvas.getBoundingClientRect();
      const pointer = (type, x, y, extra = {}) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            button: 0,
            pointerType: 'mouse',
            clientX: rect.left + x,
            clientY: rect.top + y,
            bubbles: true,
            cancelable: true,
            ...extra,
          }),
        );
      pointer('pointerdown', 64, 64);
      pointer('pointermove', 70, 68);
      pointer('pointerup', 70, 68);
      const pixel = () => {
        const m = engine.camera.matrix,
          p = point;
        const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[r + 4] * p[1] + m[r + 8] * p[2] + m[r + 12]);
        return [(1 + c[0] / c[3]) * 64, (1 - c[1] / c[3]) * 64];
      };
      engine.render({ delta: 0 });
      const grabbed = pixel();
      if (Math.hypot(grabbed[0] - 70, grabbed[1] - 68) > 0.01) throw new Error(`Surface grab pixel ${grabbed}`);
      control.zoomAt(70, 68, -250);
      engine.render({ delta: 0 });
      const zoomed = pixel();
      if (Math.hypot(zoomed[0] - 70, zoomed[1] - 68) > 0.01) throw new Error(`Cursor zoom pixel ${zoomed}`);
      control.tilt(point, 0.2, 0.4);
      engine.render({ delta: 0 });
      const bitmap = await createImageBitmap(canvas),
        flat = new OffscreenCanvas(128, 128).getContext('2d');
      flat.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = flat.getImageData(0, 0, 128, 128).data;
      let foreground = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] > 100 && pixels[i + 1] > 100 && pixels[i + 2] > 100) foreground++;
      if (foreground < 1000) throw new Error(`Globe did not render: ${foreground} pixels`);
      control.dispose();
      const before = [...engine.camera.position];
      pointer('pointerdown', 64, 64);
      pointer('pointermove', 90, 90);
      if (before.some((v, i) => v !== engine.camera.position[i])) throw new Error('Disposed globe responds to input');
      if (device) {
        await device.queue.onSubmittedWorkDone();
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
      }
      rows.push({ backend: engine.backend, foreground, grabbed, zoomed, altitude: control.altitude });
    } finally {
      control.dispose();
      mesh.dispose();
      engine.dispose();
      canvas.remove();
    }
  }
  return { rows, errors };
}
