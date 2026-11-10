import { Engine, box, PbrMaterial } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { DeviceOrientationControls } from '@margoengine/controls/device-orientation';
export async function check() {
  const rows = [],
    errors = [];
  for (const backend of ['webgpu', 'webgl2']) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 192;
    canvas.style.width = canvas.style.height = '192px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend,
      fallback: backend === 'webgl2' ? webglRenderer : undefined,
      camera: { position: [0, 0, 5], target: [0, 0, 0] },
    });
    const device = backend === 'webgpu' ? engineRuntime(engine).gpu : null;
    device?.pushErrorScope('validation');
    const white = engine
      .createMesh()
      .setGeometry(box())
      .setMaterial(new PbrMaterial({ color: '#ffffff', unlit: true }));
    const red = engine
      .createMesh()
      .setGeometry(box())
      .setPosition([-4, 0, 5])
      .setMaterial(new PbrMaterial({ color: '#ff0000', unlit: true }));
    const target = new EventTarget();
    let listeners = 0;
    const source = {
      DeviceOrientationEvent: {},
      screen: { orientation: { angle: 0 } },
      addEventListener(...args) {
        listeners++;
        target.addEventListener(...args);
      },
      removeEventListener(...args) {
        listeners--;
        target.removeEventListener(...args);
      },
    };
    const control = new DeviceOrientationControls(engine, { source, relative: false, smoothTime: 0 });
    const sample = (alpha) => {
      const event =
        typeof DeviceOrientationEvent === 'function'
          ? new DeviceOrientationEvent('deviceorientation', { alpha, beta: 90, gamma: 0, absolute: false })
          : Object.assign(new Event('deviceorientation'), { alpha, beta: 90, gamma: 0, absolute: false });
      target.dispatchEvent(event);
      engine.render({ delta: 0 });
    };
    const read = async () => {
      const image = await createImageBitmap(canvas),
        flat = new OffscreenCanvas(192, 192).getContext('2d');
      flat.drawImage(image, 0, 0);
      image.close();
      const p = flat.getImageData(0, 0, 192, 192).data;
      let white = 0,
        red = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i] > 150 && p[i + 1] > 150 && p[i + 2] > 150) white++;
        if (p[i] > 150 && p[i + 1] < 80 && p[i + 2] < 80) red++;
      }
      return { white, red };
    };
    try {
      sample(0);
      const north = await read();
      if (north.white < 100) throw new Error(`Upright sensor missed north target ${JSON.stringify(north)}`);
      sample(90);
      const west = await read();
      if (west.red < 100 || west.white !== 0)
        throw new Error(`Heading sensor did not show west target ${JSON.stringify(west)}`);
      source.screen.orientation.angle = 90;
      engine.render({ delta: 0 });
      if (engine.camera.up[2] > -0.99) throw new Error(`Screen compensation ${engine.camera.up}`);
      control.recenter();
      engine.render({ delta: 0 });
      const look = [...engine.camera.target];
      control.dispose();
      if (listeners !== 0) throw new Error(`Orientation retained ${listeners} sensor listeners`);
      sample(0);
      if (look.some((v, i) => v !== engine.camera.target[i])) throw new Error('Disposed sensor still changed camera');
      if (device) {
        await device.queue.onSubmittedWorkDone();
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
      }
      rows.push({ backend: engine.backend, north, west, up: [...engine.camera.up], listeners });
    } finally {
      control.dispose();
      white.dispose();
      red.dispose();
      engine.dispose();
      canvas.remove();
    }
  }
  return { rows, errors };
}
