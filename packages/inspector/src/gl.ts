/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type FramePass,
  type Mesh,
  type PassContext,
} from '@margoengine/core/extension';
import { Line, BoxHelper, VertexNormalsHelper, LightsHelper } from '@margoengine/lines';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { GLStats } from '@margoengine/stats/gl';
import { fault } from '../../shared/errors.js';
import { inView } from '../../shared/view-rect.js';
import { meshData, wireframe } from './debug-geometry.js';
import { editorDeleted } from './edit-state.js';

/** A captured native GL draw, including the state and shader sources actually used. */
export interface GLDrawReport {
  method: string;
  arguments: number[];
  program: number | null;
  framebuffer: number | null;
  vertexArray: number | null;
  viewport: number[];
  depthTest: boolean;
  blend: boolean;
  cullFace: boolean;
  shaders: string[];
}
/** One graph pass in one view of the captured frame. */
export interface GLFramePassReport {
  name: string;
  owner: string;
  order: number;
  view?: string;
  cpuMilliseconds: number;
  gpuMilliseconds: number | null;
  draws: GLDrawReport[];
}
/** Plain JSON capture of one preview-backend frame. Null GPU costs mean unsupported or disjoint timing. */
export interface GLFrameReport {
  backend: 'webgl2';
  gpuTiming: boolean;
  passes: GLFramePassReport[];
  drawCalls: number;
}
/** Capture cancellation and maximum GPU readback wait. */
export interface GLCaptureOptions {
  /** Default true. False waits for the next engine frame. */
  render?: boolean;
  /** Default 5000 ms, positive and finite. */
  timeout?: number;
  signal?: AbortSignal;
}
const pending = new WeakSet<Engine>();
type RecordPass = FramePass & { owner?: string };
function records(graph: FrameGraph): RecordPass[] {
  return (
    Object.values(graph).find(
      (v): v is RecordPass[] =>
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((p) => typeof p?.execute === 'function' && typeof p.name === 'string'),
    ) ?? []
  );
}
/** Captures an existing preview frame, including already-registered passes. Wrappers are removed after that frame. */
export async function captureGLFrame(handle: EngineKernel, options: GLCaptureOptions = {}): Promise<GLFrameReport> {
  const engine = engineRuntime(handle),
    gl = engine.backend === 'webgl2' ? engine.canvas.getContext('webgl2') : null,
    timeout = options.timeout ?? 5000;
  options.signal?.throwIfAborted();
  if (!gl) throw fault('unsupported', 'Use the WebGL2 preview backend for captureGLFrame');
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('Use a positive finite GL capture timeout');
  if (pending.has(engine)) throw fault('state', 'Await the current GL capture before starting another');
  pending.add(engine);
  const timer = new GLStats(),
    passes: GLFramePassReport[] = [],
    restore: (() => void)[] = [],
    ids = new WeakMap<object, number>();
  let next = 1,
    current: GLFramePassReport | undefined,
    started = false,
    timed = false,
    cancelled = false;
  const id = (value: object | null) => {
    if (!value) return null;
    if (!ids.has(value)) ids.set(value, next++);
    return ids.get(value)!;
  };
  const unpatch = () => {
    for (const off of restore.splice(0).reverse()) off();
  };
  let limit: ReturnType<typeof setTimeout> | undefined,
    poll: ReturnType<typeof setTimeout> | undefined,
    rejectCapture: (reason: unknown) => void = () => {};
  const abort = () => {
    cancelled = true;
    rejectCapture(options.signal?.reason ?? fault('disposed', 'GL capture cancelled; start a new capture'));
  };
  try {
    timer.track(gl);
    for (const method of [
      'drawArrays',
      'drawElements',
      'drawRangeElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
    ] as const) {
      const original = gl[method],
        wrapped = (...args: number[]) => {
          if (current) {
            const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
            current.draws.push({
              method,
              arguments: [...args],
              program: id(program),
              framebuffer: id(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)),
              vertexArray: id(gl.getParameter(gl.VERTEX_ARRAY_BINDING)),
              viewport: Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array),
              depthTest: gl.isEnabled(gl.DEPTH_TEST),
              blend: gl.isEnabled(gl.BLEND),
              cullFace: gl.isEnabled(gl.CULL_FACE),
              shaders: program
                ? (gl.getAttachedShaders(program) ?? []).map((shader) => gl.getShaderSource(shader) ?? '')
                : [],
            });
          }
          return Reflect.apply(original, gl, args);
        };
      Object.assign(gl, { [method]: wrapped });
      restore.push(() => {
        if (gl[method] === wrapped) Object.assign(gl, { [method]: original });
      });
    }
    const wait = new Promise<void>((resolve, reject) => {
      rejectCapture = reject;
      limit = setTimeout(
        () => reject(fault('timeout', 'GL capture timed out; render a frame or increase timeout')),
        timeout,
      );
      options.signal?.addEventListener('abort', abort, { once: true });
      const finish = () => {
        if (cancelled) return;
        timer.endFrame();
        unpatch();
        const read = () => {
          if (cancelled) return;
          timer.poll();
          const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
          if (
            !timed ||
            !timer.supported ||
            timer.sampleId > 0 ||
            (extension && gl.getParameter(extension.GPU_DISJOINT_EXT))
          )
            resolve();
          else poll = setTimeout(read, 4);
        };
        read();
      };
      const graphs = new Set([engine.frameGraph, ...[...engine.scenes].map((scene) => scene.frameGraph)]);
      for (const graph of graphs) {
        const execute = graph.execute,
          wrapped: typeof execute = (context) => {
            if (context.backend !== 'webgl2' || cancelled) return execute.call(graph, context);
            if (!started) {
              started = true;
              timed = timer.beginFrame();
              queueMicrotask(finish);
            }
            const removed: (() => void)[] = [];
            for (const pass of records(graph)) {
              const original = pass.execute,
                wrappedPass: FramePass['execute'] = (ctx) => {
                  const record: GLFramePassReport = {
                    name: pass.name,
                    owner: pass.owner ?? 'core',
                    order: pass.order,
                    view: ctx.view?.id,
                    cpuMilliseconds: 0,
                    gpuMilliseconds: null,
                    draws: [],
                  };
                  passes.push(record);
                  current = record;
                  const start = performance.now();
                  try {
                    timer.pass(String(passes.length - 1), () => original(ctx));
                  } finally {
                    record.cpuMilliseconds = performance.now() - start;
                    current = undefined;
                  }
                };
              pass.execute = wrappedPass;
              removed.push(() => {
                if (pass.execute === wrappedPass) pass.execute = original;
              });
            }
            try {
              execute.call(graph, context);
            } catch (error) {
              cancelled = true;
              reject(error);
              throw error;
            } finally {
              removed.reverse().forEach((off) => off());
            }
          };
        graph.execute = wrapped;
        restore.push(() => {
          if (graph.execute === wrapped) graph.execute = execute;
        });
      }
    });
    if (options.render !== false) {
      try {
        engine.render();
      } catch (error) {
        cancelled = true;
        rejectCapture(error);
      }
    }
    await wait;
    for (const pass of timer.passes)
      if (passes[Number(pass.name)]) passes[Number(pass.name)].gpuMilliseconds = pass.milliseconds;
    return {
      backend: 'webgl2',
      gpuTiming: timer.sampleId > 0,
      passes,
      drawCalls: passes.reduce((n, p) => n + p.draws.length, 0),
    };
  } finally {
    cancelled = true;
    clearTimeout(limit);
    clearTimeout(poll);
    options.signal?.removeEventListener('abort', abort);
    unpatch();
    timer.dispose();
    pending.delete(engine);
  }
}

/** WebGL2 overlay panel placement. */
export interface GLInspectorOptions {
  /** Default document.body; null keeps the controls detached. */
  parent?: HTMLElement | ShadowRoot | null;
  signal?: AbortSignal;
}
type Mode = 'wireframe' | 'normals' | 'bounds' | 'lights';
const vertex = `#version 300 es
precision highp float;layout(location=0) in vec3 position;uniform mat4 camera;uniform mat4 model;void main(){gl_Position=camera*model*vec4(position,1.0);}`;
const fragment = `#version 300 es
precision highp float;uniform vec3 color;out vec4 outputColor;void main(){outputColor=vec4(color,1.0);}`;
// This overlay owns its two fixed shaders. No preview renderer or compatibility-device implementation is loaded.
function debugProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw fault('failed', 'Cannot allocate the GL debug program; restore the context and reattach');
  const shaders: WebGLShader[] = [];
  try {
    [vertex, fragment].forEach((source, index) => {
      const shader = gl.createShader(index === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
      if (!shader) throw fault('failed', 'Cannot allocate a GL debug shader; restore the context and reattach');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw fault(
          'failed',
          `GL debug shader failed: ${gl.getShaderInfoLog(shader) ?? 'unknown compiler error'}; check the driver`,
        );
      gl.attachShader(program, shader);
    });
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw fault(
        'failed',
        `GL debug program failed: ${gl.getProgramInfoLog(program) ?? 'unknown linker error'}; check the driver`,
      );
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}
let serial = 0;
/** Wireframe, world normals, bounds, light helpers and one-frame capture for the WebGL2 preview backend. */
export class GLInspector implements EnginePlugin {
  readonly name = `inspector:gl:${++serial}`;
  readonly element: HTMLElement;
  readonly debug = { wireframe: false, normals: false, bounds: false, lights: false };
  private readonly runtime: Engine;
  private readonly helpers = new Map<Mesh, { source: object; wireframe?: Line; normals?: Line; bounds?: Line }>();
  private light?: LightsHelper;
  private program?: WebGLProgram;
  private buffer?: WebGLBuffer;
  private vao?: WebGLVertexArrayObject;
  private gl?: WebGL2RenderingContext;
  private disposed = false;
  private readonly inputs = new Map<Mode, HTMLInputElement>();
  private readonly controller = new AbortController();
  private readonly abort = () => this.dispose();
  private readonly lost = () => {
    this.program = undefined;
    this.buffer = undefined;
    this.vao = undefined;
  };
  /** Installs an independent panel; pass inspector.root as parent to place it beside the scene tree. */
  static attach(engine: EngineKernel, options: GLInspectorOptions = {}): GLInspector {
    const result = new GLInspector(engine, options);
    try {
      engine.use(result);
      return result;
    } catch (error) {
      result.dispose();
      throw error;
    }
  }
  constructor(
    readonly engine: EngineKernel,
    private readonly options: GLInspectorOptions = {},
  ) {
    options.signal?.throwIfAborted();
    this.runtime = engineRuntime(engine);
    const doc = engine.canvas.ownerDocument;
    this.element = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    legend.textContent = 'WebGL2 debug';
    this.element.append(legend);
    for (const mode of Object.keys(this.debug) as Mode[]) {
      const label = doc.createElement('label'),
        input = doc.createElement('input');
      input.type = 'checkbox';
      label.textContent = mode;
      label.append(input);
      this.element.append(label);
      input.addEventListener('change', () => this.setDebug(mode, input.checked));
      this.inputs.set(mode, input);
    }
    const button = doc.createElement('button'),
      output = doc.createElement('pre');
    button.type = 'button';
    button.textContent = 'Capture GL frame';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        output.textContent = JSON.stringify(await this.capture(), null, 2);
      } catch (error) {
        output.textContent = String(error);
      } finally {
        button.disabled = false;
      }
    });
    this.element.append(button, output);
    (options.parent === undefined ? doc.body : options.parent)?.append(this.element);
    options.signal?.addEventListener('abort', this.abort, { once: true });
    engine.canvas.addEventListener('webglcontextlost', this.lost);
  }
  setup(): void {
    this.gl = this.runtime.backend === 'webgl2' ? (this.engine.canvas.getContext('webgl2') ?? undefined) : undefined;
    if (!this.gl || this.runtime.backend !== 'webgl2')
      throw fault('unsupported', 'GLInspector requires the WebGL2 preview backend');
  }
  /** Turns an overlay on or off. */
  setDebug(mode: Mode, enabled: boolean): void {
    if (this.disposed) throw fault('disposed', 'Create a new GLInspector after disposal');
    if (!Object.hasOwn(this.debug, mode) || typeof enabled !== 'boolean')
      throw new TypeError('Use wireframe, normals, bounds or lights and a boolean');
    this.debug[mode] = enabled;
    this.inputs.get(mode)!.checked = enabled;
  }
  /** Captures one frame and shows the native draw state; disposal aborts the operation. */
  capture(options: GLCaptureOptions = {}): Promise<GLFrameReport> {
    return captureGLFrame(this.engine, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal,
    });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 20,
      execute: (context) => {
        if (context.backend === 'webgl2') this.draw(context);
      },
    });
  }
  private gather(): unknown[] {
    const { direction, radiance } = this.runtime.lighting,
      lights: unknown[] = [];
    if (direction[3] > 0)
      lights.push({
        direction: [-direction[0], -direction[1], -direction[2]],
        color: [radiance[0], radiance[1], radiance[2]],
      });
    for (const plugin of this.runtime.plugins.values()) {
      const list = (plugin as { list?: unknown }).list;
      if (plugin.name.startsWith('clustered') && Array.isArray(list)) lights.push(...list);
      else if (plugin.name.startsWith('environment:') && 'sky' in plugin) lights.push(plugin);
    }
    return lights;
  }
  private draw(context: PassContext): void {
    const gl = this.gl!;
    if (gl.isContextLost()) return;
    const scene = this.runtime.sceneOf(this) ?? this.runtime.scene,
      lines: Line[] = [];
    for (const [mesh, helpers] of this.helpers)
      if (!scene.meshes.has(mesh.id) || meshData(mesh)?.identity !== helpers.source) {
        helpers.wireframe?.dispose();
        helpers.normals?.dispose();
        helpers.bounds?.dispose();
        this.helpers.delete(mesh);
      }
    for (const mesh of scene.meshes.values()) {
      const source = meshData(mesh);
      if (!source || editorDeleted.has(mesh) || !inView(context, mesh) || !meshWorldMatrix(this.runtime, mesh))
        continue;
      let helpers = this.helpers.get(mesh);
      if (!helpers) {
        helpers = { source: source.identity };
        this.helpers.set(mesh, helpers);
      }
      for (const mode of ['wireframe', 'normals', 'bounds'] as const)
        if (this.debug[mode]) {
          const line = (helpers[mode] ??=
            mode === 'wireframe'
              ? wireframe(mesh)
              : mode === 'normals'
                ? new VertexNormalsHelper(mesh, { size: source.radius * 0.15, color: '#ed6b86' })
                : new BoxHelper(mesh, { color: '#e4ba31' }));
          if (line.update(this.engine) !== false) lines.push(line);
        }
    }
    if (this.debug.lights) {
      this.light ??= new LightsHelper(() => this.gather(), { size: 0.25 });
      this.light.update();
      lines.push(this.light);
    }
    if (!lines.length) return;
    const program = gl.getParameter(gl.CURRENT_PROGRAM),
      vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      buffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      mask = gl.getParameter(gl.DEPTH_WRITEMASK),
      width = gl.getParameter(gl.LINE_WIDTH),
      colorMask = gl.getParameter(gl.COLOR_WRITEMASK),
      flags = [gl.DEPTH_TEST, gl.BLEND, gl.CULL_FACE].map((flag) => [flag, gl.isEnabled(flag)] as const);
    try {
      if (!this.program) {
        this.program = debugProgram(gl);
        this.buffer = gl.createBuffer() ?? undefined;
        this.vao = gl.createVertexArray() ?? undefined;
        if (!this.buffer || !this.vao)
          throw fault('failed', 'Cannot allocate GL debug buffers; free resources and reattach');
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      }
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao!);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer!);
      flags.forEach(([flag]) => gl.disable(flag));
      gl.depthMask(false);
      gl.colorMask(true, true, true, true);
      gl.lineWidth(1);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'camera'), false, context.camera.matrix);
      for (const line of lines) {
        const model = line.attachedMesh ? meshWorldMatrix(this.runtime, line.attachedMesh) : line.matrix;
        if (!model) continue;
        gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'model'), false, model);
        gl.uniform3fv(gl.getUniformLocation(this.program, 'color'), line.material.color);
        gl.bufferData(gl.ARRAY_BUFFER, line.points.subarray(0, line.count * 4), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.LINES, 0, line.count);
      }
    } finally {
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.depthMask(mask);
      gl.lineWidth(width);
      gl.colorMask(...(colorMask as [boolean, boolean, boolean, boolean]));
      flags.forEach(([flag, enabled]) => (enabled ? gl.enable(flag) : gl.disable(flag)));
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.options.signal?.removeEventListener('abort', this.abort);
    this.engine.canvas.removeEventListener('webglcontextlost', this.lost);
    for (const helpers of this.helpers.values()) {
      helpers.wireframe?.dispose();
      helpers.normals?.dispose();
      helpers.bounds?.dispose();
    }
    this.helpers.clear();
    this.light?.dispose();
    if (this.gl) {
      if (this.gl.getParameter(this.gl.CURRENT_PROGRAM) === this.program) this.gl.useProgram(null);
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
    }
    this.element.remove();
    this.runtime.sceneOf(this)?.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
