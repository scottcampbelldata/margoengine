import RAPIER from '@dimforge/rapier3d-compat';
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { Physics } from '@margoengine/physics';
import { SceneTarget } from '../../shared/msaa.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const SIZE = 256;

// Test-only plugin: redirects the frame into a copyable texture, then copies it to a mappable buffer.
class Capture {
  name = 'capture';
  setup(engine) {
    this.device = engine.gpu;
    this.texture = undefined;
  }
  registerPasses(graph) {
    graph.add({
      name: 'capture:redirect',
      order: -100,
      execute: (context) => {
        if (!this.texture) {
          this.format = context.format;
          this.texture = this.device.createTexture({
            size: [context.width, context.height],
            format: context.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
          });
          this.depth = this.device.createTexture({
            size: [context.width, context.height],
            format: context.descriptor.depthStencil.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
          this.target = new SceneTarget(this.device, this.texture, this.depth, context.descriptor.multisample.count);
          this.buffer = this.device.createBuffer({
            size: context.width * context.height * 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
        }
        this.target.begin(context);
      },
    });
    graph.add({
      name: 'capture:copy',
      order: 900,
      execute: (context) => {
        this.target.present(context);
        context.encoder.copyTextureToBuffer(
          { texture: this.texture },
          { buffer: this.buffer, bytesPerRow: context.width * 4 },
          [context.width, context.height],
        );
      },
    });
  }
  dispose() {
    this.target?.dispose();
    this.depth?.destroy();
    this.texture?.destroy();
    this.buffer?.destroy();
    this.target = this.depth = this.texture = this.buffer = undefined;
  }
  async read() {
    await this.buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(this.buffer.getMappedRange()).slice();
    this.buffer.unmap();
    if (this.format.startsWith('bgra'))
      for (let i = 0; i < bytes.length; i += 4) {
        const b = bytes[i];
        bytes[i] = bytes[i + 2];
        bytes[i + 2] = b;
      }
    return { bytes, at: (x, y) => [...bytes.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3)] };
  }
}

// World point to pixel with the engine's column-major view-projection.
const project = (m, [x, y, z]) => {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12],
    cy = m[1] * x + m[5] * y + m[9] * z + m[13],
    w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [Math.round(((cx / w) * 0.5 + 0.5) * SIZE - 0.5), Math.round((0.5 - (cy / w) * 0.5) * SIZE - 0.5)];
};

window.runPhysicsTests = async () => {
  await RAPIER.init();
  const canvas = document.querySelector('#view');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 3, 14], target: [0, 2.5, 0], fov: 45, near: 0.1, far: 100 },
  });
  const runtime = engineRuntime(engine),
    device = runtime.gpu,
    report = { checks: [], backend: engine.backend, rapier: RAPIER.version() };
  const errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const capture = new Capture();
  engine.use(capture);
  const physics = new Physics(engine, { rapier: RAPIER });
  assert(engine.hasPlugin('physics'), 'physics plugin attached');

  const floor = engine
    .createMesh()
    .setGeometry(box(12, 1, 12))
    .setMaterial(new PbrMaterial({ color: '#808080' }))
    .setPosition([0, -0.5, 0]);
  physics.addBody(floor, { type: 'fixed' });
  const cube = box(1, 1, 1),
    red = new PbrMaterial({ color: '#ff2020' }),
    blue = new PbrMaterial({ color: '#2040ff' });
  const stack = [];
  for (let i = 0; i < 5; i++) {
    const mesh = engine
      .createMesh()
      .setGeometry(cube)
      .setMaterial(i % 2 ? blue : red)
      .setPosition([0.02 * (i % 2), 2 + i * 1.3, 0])
      .setRotation([0, 0.05 * i, 0]);
    stack.push({ mesh, body: physics.addBody(mesh, { colliders: { shape: 'box', friction: 0.8 } }), red: i % 2 === 0 });
  }

  // Mid-fall frames: the rendered world matrix equals the interpolated physics pose.
  let worstMoving = 0;
  const deltas = [1 / 60, 1 / 75, 1 / 50, 1 / 144, 1 / 30];
  for (let frame = 0; frame < 40; frame++) {
    engine.render({ delta: deltas[frame % deltas.length] });
    for (const { mesh, body } of stack) {
      const matrix = meshRuntime(mesh).matrix,
        p = body.pose,
        a = physics.alpha;
      for (let axis = 0; axis < 3; axis++)
        worstMoving = Math.max(worstMoving, Math.abs(matrix[12 + axis] - (p[axis] + (p[axis + 7] - p[axis]) * a)));
    }
  }
  assert(worstMoving < 1e-4, `Rendered positions differ from the interpolated physics state by ${worstMoving}`);
  assert(
    stack.some(({ body }) => Math.abs(body.linearVelocity[1]) > 1),
    'boxes were falling during the check',
  );
  report.movingError = worstMoving;
  report.checks.push(
    'While falling, rendered world matrices equal the interpolated physics poses (variable frame times)',
  );

  // Let the stack settle.
  for (let frame = 0; frame < 300; frame++) engine.render({ delta: 1 / 60 });
  const image = await capture.read();
  report.stack = [];
  for (const [i, { mesh, body, red: isRed }] of stack.entries()) {
    const [x, y, z] = body.position,
      matrix = meshRuntime(mesh).matrix;
    const rendered = [matrix[12], matrix[13], matrix[14]];
    const error = Math.max(...rendered.map((v, axis) => Math.abs(v - body.position[axis])));
    const pixel = project(engine.camera.matrix, [x, y, z + 0.5]),
      color = image.at(...pixel);
    report.stack.push({ y: Math.round(y * 1000) / 1000, error, pixel, color, sleeping: body.sleeping });
    assert(Math.abs(y - (0.5 + i)) < 0.05 && Math.abs(x) < 0.1, `Box ${i} settled at ${body.position}`);
    assert(error < 1e-4, `Box ${i} renders ${rendered} but physics says ${body.position}`);
    assert(isRed ? color[0] > color[2] + 40 : color[2] > color[0] + 40, `Box ${i} pixel ${pixel} is ${color}`);
  }
  const floorPixel = image.at(...project(engine.camera.matrix, [3, 0, 3])),
    sky = image.at(4, 4);
  assert(Math.abs(floorPixel[0] - floorPixel[2]) < 20 && floorPixel[0] > 20, `Floor pixel is ${floorPixel}`);
  report.floor = floorPixel;
  report.background = sky;
  const snapshot = document.createElement('canvas');
  snapshot.width = snapshot.height = SIZE;
  const rgba = new Uint8ClampedArray(image.bytes);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  snapshot.getContext('2d').putImageData(new ImageData(rgba, SIZE, SIZE), 0, 0);
  report.image = snapshot.toDataURL('image/png');
  report.checks.push('Stack of 5 boxes falls and settles at 0.5, 1.5, 2.5, 3.5, 4.5');
  report.checks.push(
    'Settled meshes render where the bodies are; readback pixels at projected centers match each box color',
  );

  // Raycast from the camera returns the core mesh it hits.
  const hit = physics.raycast(engine.camera.position, [
    0 - engine.camera.position[0],
    2.5 - engine.camera.position[1],
    0.5 - engine.camera.position[2],
  ]);
  assert(hit && hit.mesh === stack[2].mesh, 'raycast through the middle box returns its mesh');
  report.checks.push('Raycast from the camera returns the hit core Mesh');

  const validation = await device.popErrorScope();
  assert(!validation && !errors.length, `WebGPU validation errors: ${validation?.message ?? ''} ${errors.join('; ')}`);
  report.validationErrors = 0;
  report.checks.push('Zero WebGPU validation errors');

  engine.dispose();
  assert(physics.isDisposed && !stack[0].body.valid, 'engine.dispose() disposes the physics plugin');
  report.checks.push('engine.dispose() frees the physics world');
  return report;
};
