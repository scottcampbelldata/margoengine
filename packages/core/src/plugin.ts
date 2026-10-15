import type { Engine, Mesh } from './engine.js';
import type { Camera } from './camera.js';
import type { Batch } from './renderer.js';

export interface DrawOptions {
  pipeline?: GPURenderPipeline;
  bindings?: GPUBindGroupEntry[];
  clear?: boolean;
  stencilClear?: number;
  indirect?: boolean;
  colorAttachments?: GPURenderPassColorAttachment[];
}
export type PassContext = {
  delta: number;
  width: number;
  height: number;
  camera: Camera;
  draw(options?: DrawOptions): void;
} & (
  | {
      backend: 'webgpu';
      /** This frame's drawn batches in draw order (read-only except Batch.redirect); absent in pick passes. */
      batches?: readonly Batch[];
      device: GPUDevice;
      encoder: GPUCommandEncoder;
      color: GPUTextureView;
      depth: GPUTextureView;
      format: GPUTextureFormat;
      shader: string;
      bindings: GPUBindGroupEntry[];
      indirect: boolean;
      descriptor: GPURenderPipelineDescriptor;
    }
  | { backend: 'webgl2'; gl: WebGL2RenderingContext }
);
export interface FramePass {
  name: string;
  order: number;
  execute(context: PassContext): void;
  prepare?(context: PassContext): void;
}
export interface EnginePlugin {
  name: string;
  setup(engine: Engine): void;
  onPreUpdate?(delta: number): void;
  registerPasses?(graph: FrameGraph): void;
  onDeviceRestored?(engine: Engine): void;
  onPick?(x: number, y: number): Promise<Mesh | null>;
  dispose?(): void;
}

export class FrameGraph {
  revision = 0;
  private passes: Array<FramePass & { owner?: string }> = [
    { name: 'main', order: 0, execute: (context) => context.draw() },
  ];
  private owner?: string;
  private executing = false;
  add(pass: FramePass): () => void {
    if (this.executing) throw new Error('Graph executing');
    if (
      !pass.name ||
      !Number.isFinite(pass.order) ||
      typeof pass.execute !== 'function' ||
      this.passes.some((p) => p.name === pass.name)
    )
      throw new TypeError('Invalid pass');
    const record = { ...pass, owner: this.owner };
    this.passes.push(record);
    this.passes.sort((a, b) => a.order - b.order);
    this.revision++;
    return () => {
      if (this.executing) throw new Error('Graph executing');
      this.passes = this.passes.filter((p) => p !== record);
      this.revision++;
    };
  }
  withOwner(owner: string, register: () => void): void {
    const previous = this.owner;
    this.owner = owner;
    try {
      register();
    } finally {
      this.owner = previous;
    }
  }
  removeOwner(owner: string): void {
    if (this.executing) throw new Error('Graph executing');
    this.passes = this.passes.filter((p) => p.owner !== owner);
    this.revision++;
  }
  execute(context: PassContext): void {
    if (this.executing) throw new Error('Graph recursion');
    this.executing = true;
    try {
      for (const pass of this.passes) pass.execute(context);
    } finally {
      this.executing = false;
    }
  }
  prepare(context: PassContext): void {
    if (this.executing) throw new Error('Graph recursion');
    this.executing = true;
    try {
      for (const pass of this.passes) pass.prepare?.(context);
    } finally {
      this.executing = false;
    }
  }
}
