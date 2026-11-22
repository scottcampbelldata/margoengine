/// <reference lib="esnext.disposable" preserve="true" />
// A full-screen GLSL program as a stage of @margoengine/post's PostStack: the program is a ShaderMaterial drawn over
// one triangle that covers the target, reading the stack's colour under the input name of its convention. Optional
// entry @margoengine/shader/glsl-pass. Written clean room from the GLSL ES 1.00 and 3.00 specifications and the public
// documentation of other web engines' post passes (docs/clean-room.md, "GLSL programs as materials").
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { applyView, viewLoadOp, viewRect } from '../../shared/view-rect.js';
import { RawShaders, type RawMesh } from './raw.js';
import { ownStack, type OwnStack } from './own-stack.js';
import { GLSLMaterial, shaderMesh, type ShaderMaterialOptions, type ShaderUniform } from './glsl/material.js';
// The type only: a pass's material is the program core, which `instanceof ShaderMaterial` accepts.
import type { ShaderMaterial } from './glsl-material.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** The program of a {@link ShaderPass}, in the `{uniforms, vertexShader, fragmentShader}` form web engines use. */
export interface ShaderPassShader {
  /** GLSL ES 1.00 or 3.00 with `void main()`. Default: a full-screen triangle writing `vUv`, `vUV` or `vUv0`, whichever the fragment declares. */
  readonly vertexShader?: string;
  /** GLSL ES 1.00 or 3.00 with `void main()`. */
  readonly fragmentShader: string;
  /** Live values by GLSL name. */
  readonly uniforms?: Record<string, ShaderUniform>;
  /** Object-like macros defined before both stages. */
  readonly defines?: Readonly<Record<string, string | number | boolean>>;
}
/** Options for `new ShaderPass(shader, options)`. */
export interface ShaderPassOptions
  extends Pick<
    ShaderMaterialOptions,
    | 'glslVersion'
    | 'flipY'
    | 'strict'
    | 'builtins'
    | 'attributes'
    | 'includes'
    | 'outputColorSpace'
    | 'blending'
    | 'unfilterable'
  > {
  /**
   * `'ldr'` (default) runs after tonemapping on display colour; `'hdr'` runs on linear light before it and, when last,
   * applies the display curve (its `outputColorSpace` defaults to `'linear'`).
   */
  readonly kind?: 'hdr' | 'ldr';
  /** Plugin and debug name. Default `'shader:glsl-pass:<n>'` (n counts passes). */
  readonly name?: string;
  /**
   * The sampler uniform that receives the stack's colour. Default the first of `tDiffuse`, `textureSampler` and
   * `uColorBuffer` the program declares; null for none.
   */
  readonly input?: string | null;
}
/** Options for `ShaderPass.attach(engine, shader, options)`. */
export interface ShaderPassAttachOptions extends ShaderPassOptions {
  /** Aborts the attach while `@margoengine/post` loads; the pass is then disposed and nothing attaches. */
  readonly signal?: AbortSignal;
}
const inputs = ['tDiffuse', 'textureSampler', 'uColorBuffer'],
  coordinates = ['vUv', 'vUV', 'vUv0'];
// GL's identity projection read through Margo's: clip z (w - z) / 2 is Margo's reversed depth of GL's z, so
// `projectionMatrix` and `modelViewMatrix` of every convention are the identity in a pass, as for a full-screen quad.
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  screen = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.5, 0, 0, 0, 0.5, 1],
  world = new Float32Array(identity);
// One triangle over the whole target, uv (0, 0) at the lower left as GL's.
const triangle = { positions: [-1, -1, 0, 3, -1, 0, -1, 3, 0], uvs: [0, 0, 2, 0, 0, 2] };
const declares = (code: string, type: string, name: string) =>
  new RegExp(`\\b(?:uniform|varying|in)\\s+(?:(?:highp|mediump|lowp)\\s+)?${type}\\s+${name}\\b`).test(code);
/** The vertex stage a pass without one gets: the triangle, with each coordinate varying the fragment reads. */
export function fullscreenVertex(fragmentShader: string, glslVersion?: 100 | 300): string {
  const es3 = /^\s*#\s*version\s+300\s+es\b/m.test(fragmentShader) || glslVersion === 300,
    names = coordinates.filter((n) => declares(fragmentShader, 'vec2', n)),
    [input, output] = es3 ? ['in', 'out'] : ['attribute', 'varying'];
  return `${es3 ? '#version 300 es\n' : ''}${input} vec3 position;\n${input} vec2 uv;\n${names.map((n) => `${output} vec2 ${n};\n`).join('')}void main() { ${names.map((n) => `${n} = uv; `).join('')}gl_Position = vec4(position.xy, 0.0, 1.0); }\n`;
}
let passes = 0;
/**
 * A full-screen GLSL program, run by `@margoengine/post`'s PostStack: `PostStack.attach(engine, [new Tonemap(), pass])`,
 * or alone in a stack of its own with `await ShaderPass.attach(engine, shader)`.
 * The stack's colour reaches the sampler named by `input`; `uniforms` stay live (`pass.uniforms.amount.value = 1`).
 */
export class ShaderPass implements EnginePlugin {
  readonly name: string;
  readonly kind: 'hdr' | 'ldr';
  /** The program as a ShaderMaterial: `material.code('fragment')` shows its WGSL. */
  readonly material: ShaderMaterial;
  /** The sampler uniform that receives the stack's colour, or null. */
  readonly input: string | null;
  private readonly raw = new RawShaders({ name: 'shader:glsl-pass:raw' });
  private readonly mesh: RawMesh<ShaderMaterial>;
  private host?: StackHost;
  private engine?: Engine;
  private stack?: OwnStack;
  private disposed = false;
  private device?: GPUDevice;
  private rect = '';
  private camera?: GPUBuffer;
  private readonly context: { format: GPUTextureFormat; descriptor: { multisample: GPUMultisampleState } } = {
    format: 'rgba8unorm',
    descriptor: { multisample: { count: 1 } },
  };
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly pass: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  constructor(shader: ShaderPassShader, options: ShaderPassOptions = {}) {
    if (!shader || typeof shader !== 'object' || typeof shader.fragmentShader !== 'string')
      throw new TypeError('ShaderPass needs {fragmentShader}, with vertexShader and uniforms if the program has them');
    const { kind = 'ldr', name = 'shader:glsl-pass:' + passes++, input, ...rest } = options;
    if (kind !== 'hdr' && kind !== 'ldr') throw new TypeError("ShaderPass kind must be 'hdr' or 'ldr'");
    this.name = name;
    this.kind = kind;
    const fragmentShader = shader.fragmentShader,
      vertexShader = shader.vertexShader ?? fullscreenVertex(fragmentShader, rest.glslVersion);
    this.input = input === undefined ? (inputs.find((n) => declares(fragmentShader, 'sampler2D', n)) ?? null) : input;
    this.material = new GLSLMaterial({
      outputColorSpace: kind === 'hdr' ? 'linear' : 'srgb',
      blending: 'none',
      ...rest,
      vertexShader,
      fragmentShader,
      uniforms: { ...shader.uniforms },
      defines: { ...shader.defines },
      side: 'double',
      depthTest: false,
      depthWrite: false,
      name,
    });
    if (this.input !== null && !this.material.program.textures.some((t) => t.name === this.input))
      throw new MargoError(
        'failed',
        `ShaderPass input ${this.input} is not a sampler of the program; declare it or pass input: null`,
      );
    this.mesh = shaderMesh(triangle, this.material, { frustumCulled: false });
  }
  /**
   * Adds a new ShaderPass to the PostStack of the engine's scene, after the last effect of its kind, or runs it in a new
   * PostStack when the scene has none (loads `@margoengine/post` when called). Disposing the pass removes it from that
   * stack, and a stack made for it goes with it. `PostStack.join(engine, new ShaderPass(shader), index)` places it yourself.
   * @throws MargoError `'unsupported'` on a WebGL engine; the stack's errors (a repeated name, an HDR pass on the LDR
   * tier); the signal's reason when aborted before the pass attaches.
   */
  static async attach(
    engine: EngineKernel,
    shader: ShaderPassShader,
    options: ShaderPassAttachOptions = {},
  ): Promise<ShaderPass> {
    const { signal, ...rest } = options;
    signal?.throwIfAborted();
    const pass = new ShaderPass(shader, rest);
    pass.stack = await ownStack(engine, pass, signal);
    return pass;
  }
  /** Live values by GLSL name. */
  get uniforms(): Record<string, ShaderUniform> {
    return this.material.uniforms;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.host || this.disposed)
      throw new MargoError(
        this.disposed ? 'disposed' : 'attached',
        `${this.name} is already attached; create a new ShaderPass for another PostStack`,
      );
    this.host = host;
    return { kind: this.kind, render: (c, input, output) => this.render(c, input, output) };
  }
  setup(engine: Engine): void {
    if (!this.host || this.disposed)
      throw new MargoError('state', 'ShaderPass runs inside a PostStack: PostStack.attach(engine, [pass])');
    if (!engine.gpu) throw new MargoError('unsupported', 'ShaderPass requires WebGPU; use a WebGPU engine');
    this.engine = engine;
  }
  registerPasses(): void {}
  /** Resolves when the program's pipelines have compiled. */
  ready(): Promise<void> {
    return this.raw.ready();
  }
  /** How the program's colour reaches a target of `format`: 0 a float target (linear light), 2 an sRGB format, 1 as written. */
  protected encoding(format: GPUTextureFormat): number {
    return format.includes('float') ? 0 : format.endsWith('-srgb') ? 2 : 1;
  }
  /** Draws the program into `output`; a subclass may set its inputs first. */
  protected render(c: Context, input: GPUTextureView, output: StageOutput): void {
    const device = c.device,
      m = this.material;
    if (this.device !== device) this.release();
    this.device = device;
    if (this.input !== null) m.uniforms[this.input]!.value = input;
    const camera = (this.camera ??= device.createBuffer({
        label: this.name + ':camera',
        size: 240,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })),
      format = output.format,
      rect = viewRect(c),
      block = this.raw.cameraBlock(c.camera, screen, c.width, c.height, c.delta, this.encoding(format), rect);
    block.set(identity, 0);
    block.set(screen, 16);
    block.fill(0, 48, 51);
    device.queue.writeBuffer(camera, 0, block);
    // In a view of a multi-view frame the triangle covers the view, and its uv names the input's pixels under it.
    const key = rect ? rect.join() : '';
    if (key !== this.rect && this.mesh.getAttribute('uv')) {
      this.rect = key;
      const [x, y, w, h] = rect ?? [0, 0, c.width, c.height],
        u = (px: number) => px / c.width,
        v = (py: number) => 1 - py / c.height;
      this.mesh.setAttribute('uv', [u(x), v(y + h), u(x + 2 * w), v(y + h), u(x), v(y - h)]);
    }
    const call = this.mesh.upload(device, camera, world)!,
      gpu = m.prepare(device, this.raw.nextPass());
    this.context.format = format;
    this.context.descriptor.multisample = output.multisample;
    // A context without depth: one colour target, compiled at once (as NodePass), so the first frame draws.
    const pipeline = m.pipeline(this.raw, gpu, device, this.mesh, 'color', this.context as unknown as Context);
    this.attachment.view = output.view;
    this.attachment.loadOp = viewLoadOp(c);
    const pass = c.encoder.beginRenderPass(this.pass);
    applyView(pass, c);
    if (pipeline) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.mesh.gpu!.group!);
      if (gpu.group) pass.setBindGroup(1, gpu.group);
      gpu.extras.forEach((extra, i) => pass.setBindGroup(2 + i, extra));
      this.mesh.draw(pass, call[0], call[1], call[2], { slots: [] });
    }
    pass.end();
  }
  private release(): void {
    const device = this.device;
    this.mesh.release();
    if (device) {
      this.material.gpu.get(device)?.buffer?.destroy();
      this.material.gpu.delete(device);
    }
    this.camera?.destroy();
    this.camera = this.device = undefined;
  }
  onDeviceRestored(): void {
    this.release();
  }
  /** Removes the pass, from the PostStack {@link ShaderPass.attach} joined too; safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine,
      stack = this.stack;
    this.engine = this.stack = undefined;
    stack?.removeEffect(this);
    this.release();
    this.material.dispose();
    this.mesh.dispose();
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
