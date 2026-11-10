import { Engine, box, PbrMaterial } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { PresentationControls, ScrollControls, ScrollArea, PathControls } from '@margoengine/controls/presentation';
import { Spline } from '@margoengine/splines';
export async function check() {
  const rows = [],
    errors = [];
  for (const backend of ['webgpu', 'webgl2']) {
    const parent = document.createElement('div'),
      canvas = document.createElement('canvas');
    Object.assign(parent.style, { position: 'relative', width: '256px', height: '256px' });
    canvas.width = canvas.height = 256;
    canvas.style.width = canvas.style.height = '256px';
    parent.append(canvas);
    document.body.append(parent);
    const engine = await Engine.create(canvas, {
      backend,
      fallback: backend === 'webgl2' ? webglRenderer : undefined,
      camera: { position: [0, 0, 5], target: [0, 0, 0] },
    });
    const device = backend === 'webgpu' ? engineRuntime(engine).gpu : null;
    device?.pushErrorScope('validation');
    const mesh = engine
      .createMesh()
      .setGeometry(box())
      .setMaterial(new PbrMaterial({ color: '#ffffff', unlit: true }));
    const presentation = new PresentationControls(engine, mesh, { snap: true });
    let area, scroll, path;
    const read = async () => {
      const image = await createImageBitmap(canvas),
        flat = new OffscreenCanvas(256, 256).getContext('2d');
      flat.drawImage(image, 0, 0);
      image.close();
      return flat.getImageData(0, 0, 256, 256).data;
    };
    try {
      engine.render({ delta: 0 });
      const before = await read(),
        rect = canvas.getBoundingClientRect();
      const event = (type, x, y) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            clientX: rect.left + x,
            clientY: rect.top + y,
            pointerId: 1,
            button: 0,
            pointerType: 'mouse',
          }),
        );
      event('pointerdown', 128, 128);
      event('pointermove', 190, 155);
      for (let i = 0; i < 120; i++) engine.render({ delta: 1 / 60 });
      const rotated = await read();
      let different = 0;
      for (let i = 0; i < before.length; i += 4) if (before[i] !== rotated[i]) different++;
      if (different < 100 || presentation.angles[1] < 0.5)
        throw new Error(`Product did not rotate ${different}, ${presentation.angles}`);
      event('pointerup', 190, 155);
      for (let i = 0; i < 180; i++) engine.render({ delta: 1 / 60 });
      if (presentation.angles.some((v) => Math.abs(v) > 1e-6)) throw new Error('Presentation did not snap back');
      area = new ScrollArea(canvas, { pages: 3 });
      scroll = new ScrollControls(engine, { element: area.element, damping: 0 });
      path = new PathControls(
        engine,
        new Spline([
          [0, 0, 5],
          [3, 0, 5],
        ]),
        { scroll, loop: false, damping: 0, focus: [0, 0, 0], focusDamping: 0 },
      );
      area.element.scrollTop = area.element.scrollHeight - area.element.clientHeight;
      area.element.dispatchEvent(new Event('scroll'));
      engine.render({ delta: 0 });
      if (Math.abs(scroll.offset - 1) > 1e-8 || Math.abs(engine.camera.position[0] - 3) > 1e-5)
        throw new Error(`Scroll path ${scroll.offset}, ${engine.camera.position}`);
      const end = await read();
      let white = 0;
      for (let i = 0; i < end.length; i += 4) if (end[i] > 150 && end[i + 1] > 150 && end[i + 2] > 150) white++;
      if (white < 100) throw new Error(`Focused path lost product ${white}`);
      if (device) {
        await device.queue.onSubmittedWorkDone();
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
      }
      rows.push({
        backend: engine.backend,
        different,
        white,
        offset: scroll.offset,
        position: [...engine.camera.position],
        pages: area.content.style.height,
      });
    } finally {
      path?.dispose();
      scroll?.dispose();
      area?.dispose();
      presentation.dispose();
      mesh.dispose();
      engine.dispose();
      parent.remove();
    }
  }
  return { rows, errors };
}
