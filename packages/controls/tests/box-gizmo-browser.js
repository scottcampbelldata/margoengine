import { Engine, box, PbrMaterial } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { BoxGizmo } from '@margoengine/controls/box-gizmo';

export async function check() {
  const rows = [],
    errors = [];
  for (const backend of ['webgpu', 'webgl2']) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.style.width = canvas.style.height = '256px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend,
      fallback: backend === 'webgl2' ? webglRenderer : undefined,
      camera: { position: [4, 3, 7], target: [0, 0, 0] },
    });
    const device = backend === 'webgpu' ? engineRuntime(engine).gpu : null;
    device?.pushErrorScope('validation');
    const mesh = engine
      .createMesh()
      .setGeometry(box())
      .setMaterial(new PbrMaterial({ color: '#ffffff', unlit: true }));
    const gizmo = new BoxGizmo(engine).attach(mesh);
    const pixel = (p) => {
      const m = engine.camera.matrix,
        w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      return [
        ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w + 1) * 128,
        (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) * 128,
      ];
    };
    const read = async () => {
      const image = await createImageBitmap(canvas),
        flat = new OffscreenCanvas(256, 256).getContext('2d');
      flat.drawImage(image, 0, 0);
      image.close();
      const pixels = flat.getImageData(0, 0, 256, 256).data;
      let cyan = 0,
        yellow = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] < 160 && pixels[i + 1] > 130 && pixels[i + 2] > 180) cyan++;
        if (pixels[i] > 180 && pixels[i + 1] > 130 && pixels[i + 2] < 140) yellow++;
      }
      return { cyan, yellow };
    };
    try {
      engine.render({ delta: 0 });
      const colors = await read(),
        triangles = gizmo.overlay.lastTriangles;
      if (colors.cyan < 40 || colors.yellow < 40 || triangles < 100)
        throw new Error(`Box handles did not render ${JSON.stringify({ colors, triangles })}`);
      const corners = gizmo.corners(),
        start = pixel(corners[7]),
        anchor = pixel(corners[0]);
      if (!gizmo.beginDrag(...start, 'corner-7')) throw new Error('Corner scale did not begin');
      gizmo.dragTo(start[0] + (start[0] - anchor[0]) * 0.5, start[1] + (start[1] - anchor[1]) * 0.5);
      gizmo.endDrag();
      engine.render({ delta: 0 });
      if (Math.abs(mesh.scale.x - 1.5) > 1e-5) throw new Error(`Corner scale ${mesh.scale.x}`);
      const h = gizmo.handles().find((h) => h.axis === 1),
        p = pixel(h.position);
      gizmo.beginDrag(...p, h.id);
      gizmo.dragTo(p[0] + 100, p[1]);
      gizmo.endDrag();
      engine.render({ delta: 0 });
      if (Math.abs(mesh.rotation.y) < 0.1) throw new Error(`Edge did not rotate ${mesh.rotation.y}`);
      if (device) {
        await device.queue.onSubmittedWorkDone();
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
      }
      rows.push({
        backend: engine.backend,
        ...colors,
        triangles,
        scale: mesh.scale.x,
        rotation: mesh.rotation.y,
        handles: gizmo.handles().length,
      });
    } finally {
      gizmo.dispose();
      mesh.dispose();
      engine.dispose();
      canvas.remove();
    }
  }
  return { rows, errors };
}
