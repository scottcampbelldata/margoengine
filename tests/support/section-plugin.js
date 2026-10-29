// Test-only section plugin. gltf-pro, shadows, materials and selection read a generic scene binding named `section`
// (packages/shared/section.js: `sectionState` finds it by its declaration in the frame's shader). This plugin registers
// that binding the way a section plugin does, so their tests cover the contract without any optional package:
// - a frame-graph pass (order -30, also run on `prepare`) prefixes the frame's core shader with the `Section` uniform
//   declaration at the next free group 0 binding, adds the core clip loop before core's `let facing=`, and pushes the
//   binding with its uniform buffer;
// - the 256-byte uniform holds up to 6 unit planes [a, b, c, d] (points with a x + b y + c z + d < 0 are cut away),
//   then settings (x: the plane count, 0 while `enabled` is false), a color, the camera matrix and a spare matrix;
// - its plugin name is 'section', the binding's name, which selection's picking checks for.
// The planes array is read on every frame, so a test can move a plane in place.
import { clipStatement } from '../../packages/shared/section.js';

/** The `Section` uniform struct and its group 0 binding, as the consumers find it. */
export const sectionDeclaration = (binding) =>
  `struct Section {planes:array<vec4f,6>,settings:vec4f,color:vec4f,camera:mat4x4f,inverse:mat4x4f}\n@group(0) @binding(${binding}) var<uniform> section:Section;\n`;

export class TestSectionPlugin {
  name = 'section';
  /** Clip while true; false uploads a plane count of 0 and keeps the shader and bindings. */
  enabled = true;
  buffer = null;
  row = new Float32Array(64);

  /** @param {{ planes: number[][] }} options up to 6 planes, each four finite numbers with a non-zero normal. */
  constructor({ planes }) {
    if (!Array.isArray(planes) || planes.length < 1 || planes.length > 6)
      throw new RangeError('TestSectionPlugin takes 1 to 6 planes.');
    for (const plane of planes)
      if (plane.length !== 4 || !plane.every(Number.isFinite) || Math.hypot(plane[0], plane[1], plane[2]) === 0)
        throw new TypeError('A test section plane is four finite numbers [a, b, c, d] with a non-zero normal.');
    this.planes = planes;
  }

  setup(engine) {
    if (!engine.gpu) throw new Error('TestSectionPlugin needs WebGPU.');
    const usage = globalThis.GPUBufferUsage ?? { UNIFORM: 0x40, COPY_DST: 0x8 };
    this.buffer = engine.gpu.createBuffer({ size: 256, usage: usage.UNIFORM | usage.COPY_DST });
  }

  registerPasses(graph) {
    const clip = (context) => {
      if (context.backend !== 'webgpu') return;
      const binding = context.bindings.length + 1;
      context.shader =
        sectionDeclaration(binding) + context.shader.replace('let facing=', `${clipStatement('section')}\nlet facing=`);
      context.bindings.push({ binding, resource: { buffer: this.buffer } });
      this.upload(context);
    };
    graph.add({ name: 'sections:clip', order: -30, execute: clip, prepare: clip });
  }

  upload(context) {
    const row = this.row;
    row.fill(0);
    this.planes.forEach((plane, p) => {
      const length = Math.hypot(plane[0], plane[1], plane[2]);
      for (let c = 0; c < 4; c++) row[p * 4 + c] = plane[c] / length;
    });
    row[24] = this.enabled ? this.planes.length : 0;
    row[26] = context.format === 'rgba16float' ? 1 : 0;
    row.set([1, 1, 1, 1], 28);
    row.set(context.camera.matrix, 32);
    context.device.queue.writeBuffer(this.buffer, 0, row);
  }

  dispose() {
    this.buffer?.destroy();
    this.buffer = null;
  }
}
