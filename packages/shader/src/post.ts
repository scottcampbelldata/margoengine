/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { fullscreen, render } from '../../shared/gpu.js';
import { acesShader } from '../../shared/aces.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import {
  Node,
  Program,
  cast,
  sameEntries,
  type Builder,
  type NodeInput,
  type Resource,
  type ShaderStage,
} from './node.js';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
const binding = (type: string, key: string): Resource => ({
  prefix: 'nd' + key[0],
  bindings: 1,
  declare: (name, group, b) => `@group(${group}) @binding(${b}) var ${name}:${type};`,
  entries: (_, host) => [host[key] as GPUBindingResource],
});
const input = /*@__PURE__*/ binding('texture_2d<f32>', 'input'),
  sampler = /*@__PURE__*/ binding('sampler', 'sampler'),
  depth = /*@__PURE__*/ binding('texture_depth_2d', 'depth');
const post: ShaderStage = {
  kind: 'post',
  builtins: { uv: 'v.uv', screenUV: 'v.uv', screenCoordinate: 'v.position.xy' },
};
const pixel = (b: Builder) => {
  if (b.stage.kind !== 'post')
    throw new TypeError('inputColor() and inputDepth() are only available in NodePass nodes');
  return `vec2i(${b.local('v.position.xy')})`;
};
/** The effect's input colour at this pixel, or bilinear at `coord` (0-1, origin top left). Linear HDR for `kind: 'hdr'`, display-encoded for `'ldr'`. */
export function inputColor(coord?: NodeInput<'vec2f'>): Node<'vec4f'> {
  return new Node('vec4f', 'ic', coord === undefined ? [] : [cast(coord, 'vec2f', 'inputColor uv')], (b, n) => {
    const at = pixel(b),
      t = b.resource(input);
    return n.args.length
      ? `textureSampleLevel(${t}, ${b.resource(sampler)}, ${b.expr(n.args[0])}, 0.0)`
      : `textureLoad(${t}, ${at}, 0)`;
  });
}
/** Raw scene depth at this pixel or at `coord` (reversed Z: 1 near, 0 far or sky). */
export function inputDepth(coord?: NodeInput<'vec2f'>): Node<'f32'> {
  return new Node('f32', 'id', coord === undefined ? [] : [cast(coord, 'vec2f', 'inputDepth uv')], (b, n) => {
    const at = pixel(b),
      d = b.resource(depth);
    return `textureLoad(${d}, ${n.args.length ? `vec2i(${b.wrap(n.args[0])} * vec2f(textureDimensions(${d})))` : at}, 0)`;
  });
}
let passes = 0;
/** Options for `new NodePass(node, options)`. */
export interface NodePassOptions {
  /** `'ldr'` (default) runs after tonemapping on display colour; `'hdr'` runs on linear light before it (and tonemaps with ACES when last). */
  kind?: 'hdr' | 'ldr';
  /** Plugin and debug name. Default `'shader:pass:<n>'` (n counts passes). */
  name?: string;
}
/** A full-screen effect written as one node, run by `@margoengine/post`'s PostStack: `PostStack.attach(engine, [new Tonemap(), pass])`. */
export class NodePass implements EnginePlugin {
  readonly name: string;
  readonly kind: 'hdr' | 'ldr';
  readonly program = new Program(0);
  private readonly body: string;
  private readonly value: string;
  private host?: StackHost;
  private engine?: Engine;
  private disposed = false;
  private key = '';
  private pipeline?: GPURenderPipeline;
  private group?: GPUBindGroup;
  private last: GPUBindGroupEntry[] = [];
  private sampler?: GPUSampler;
  private depthTexture?: GPUTexture;
  private depthView?: GPUTextureView;
  /** Same as `engine.use(new NodePass(...))`; returns the NodePass. */
  static attach(engine: EngineKernel, node: Node<'vec3f' | 'vec4f'>, options?: NodePassOptions): NodePass {
    const value = new NodePass(node, options);
    engine.use(value);
    return value;
  }
  constructor(
    readonly node: Node<'vec3f' | 'vec4f'>,
    { kind = 'ldr', name = 'shader:pass:' + passes++ }: NodePassOptions = {},
  ) {
    if (!(node instanceof Node) || (node.type !== 'vec3f' && node.type !== 'vec4f'))
      throw new TypeError('NodePass needs a vec3f or vec4f node');
    if (kind !== 'hdr' && kind !== 'ldr') throw new TypeError('NodePass kind is hdr or ldr');
    this.name = name;
    this.kind = kind;
    const s = this.program.stage(post, [node]);
    this.body = s.lines.map((l) => '  ' + l + '\n').join('');
    this.value = node.type === 'vec3f' ? `vec4f(${s.values[0]}, 1.0)` : s.values[0];
  }
  /** The pass WGSL; `encode` adds ACES and sRGB encoding (an HDR pass that ends the chain). */
  code(encode = false): string {
    const out = encode
      ? `let c = ${this.value};\n  let x = aces(max(c.rgb, vec3f(0.0)) / 0.6);\n  return vec4f(select(x * 12.92, 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x >= vec3f(0.0031308)), c.a);`
      : `return ${this.value};`;
    return `${fullscreen}\n${this.program.declare(0)}\n${encode ? acesShader + '\n' : ''}@fragment fn fragment(v:Vertex)->@location(0) vec4f {\n${this.body}  ${out}\n}\n`;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.host || this.disposed)
      throw new MargoError(
        this.disposed ? 'disposed' : 'attached',
        `${this.name} is already attached; create a new NodePass for another PostStack`,
      );
    this.host = host;
    return { kind: this.kind, render: (c, input, output) => this.render(c, input, output) };
  }
  setup(engine: Engine): void {
    if (!this.host || this.disposed)
      throw new MargoError('state', 'NodePass runs inside a PostStack: PostStack.attach(engine, [pass])');
    if (!engine.gpu)
      throw new MargoError('unsupported', 'NodePass requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
  }
  registerPasses(): void {}
  private render(c: Context, view: GPUTextureView, output: StageOutput): void {
    const device = c.device,
      encode = this.kind === 'hdr' && !output.hdr,
      key = output.format + output.multisample.count + encode;
    if (this.key !== key) {
      this.key = key;
      this.pipeline = render(device, this.code(encode), output.format, { multisample: output.multisample });
      this.group = undefined;
    }
    this.sampler ??= device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const t = this.host!.depthTexture;
    if (t !== this.depthTexture) {
      this.depthTexture = t;
      this.depthView = t?.createView({ aspect: 'depth-only' });
    }
    const entries = this.program.entries(device, {
      width: c.width,
      height: c.height,
      delta: c.delta,
      input: view,
      sampler: this.sampler,
      depth: this.depthView,
    });
    if (!this.group || !sameEntries(entries, this.last)) {
      this.last = entries;
      this.group = entries.length
        ? device.createBindGroup({ layout: this.pipeline!.getBindGroupLayout(0), entries })
        : undefined;
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline!);
    if (this.group) pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
  }
  onDeviceRestored(): void {
    this.key = '';
    this.sampler = this.group = this.pipeline = this.depthTexture = this.depthView = undefined;
  }
  dispose(): void {
    this.disposed = true;
    this.engine = undefined;
    this.onDeviceRestored();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
