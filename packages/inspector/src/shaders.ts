/// <reference lib="esnext.disposable" preserve="true" />
// Live WGSL editing for @margoengine/materials WgslMaterial meshes. A WgslMaterial's WGSL is fixed at construction,
// so an edit builds a new material of the same class with the edited text, the same uniforms and textures and every
// other Material value (`copy`), and swaps it onto the mesh (`mesh.material = `, which every material mesh accepts).
// The device's compiler then reports on the modules built from the new text (WebGPU `getCompilationInfo`, and
// validation error scopes around module and pipeline creation); an edit that fails puts the old material back, so the
// mesh keeps drawing. Found by shape: this entry imports none of the packages it edits.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import { EditHistory } from './history.js';

/** The shape of a `@margoengine/materials` WgslMaterial that this editor relies on. */
export interface WgslMaterialShape {
  readonly wgsl: string;
  readonly shading?: string;
  readonly uniforms: Record<string, number | ArrayLike<number>>;
  readonly textures: Record<string, unknown>;
  copy(source: WgslMaterialShape): unknown;
}
/** A mesh whose `material` can be read and assigned: a `@margoengine/materials` `createMesh` result. */
export interface ShaderMesh {
  material: unknown;
  readonly name?: string;
}
/** One compiler message, placed in the edited WGSL. */
export interface ShaderDiagnostic {
  type: 'error' | 'warning' | 'info';
  message: string;
  /** 1-based line and column in the edited WGSL; 0 when the message points outside it (the engine's own code). */
  line: number;
  column: number;
}
/** What one edit did. */
export interface ShaderEditResult {
  /** True when the mesh now draws the edited WGSL; false when it was refused and the old material is back. */
  ok: boolean;
  /** Shader modules the device built from the edited WGSL within the wait (0: not drawn yet, or no device). */
  modules: number;
  diagnostics: ShaderDiagnostic[];
}
/** Options for `recompileShader`. */
export interface RecompileOptions {
  /** The device that draws the mesh (`engine.gpu`). Without one the edit is swapped in unchecked. */
  device?: GPUDevice | null;
  /** Most milliseconds to wait for the mesh to draw the edit, 0 to 60,000. Default 3,000. */
  timeoutMs?: number;
  /** Milliseconds to keep collecting modules after the first one (other passes of the same frame). Default 50. */
  settleMs?: number;
  /** Records the swap, so undo puts the old WGSL back. */
  history?: EditHistory;
}

/** True when `material` has the WgslMaterial shape this editor edits. */
export function isWgslMaterial(material: unknown): material is WgslMaterialShape {
  const m = material as Partial<WgslMaterialShape> | null;
  return (
    !!m &&
    typeof m.wgsl === 'string' &&
    !!m.uniforms &&
    typeof m.uniforms === 'object' &&
    !!m.textures &&
    typeof m.textures === 'object' &&
    typeof m.copy === 'function'
  );
}

interface Watch {
  wgsl: string;
  modules: Map<GPUShaderModule, string>;
  scoped: Promise<string | null>[];
}
interface Hook {
  watches: Set<Watch>;
  module: GPUDevice['createShaderModule'];
  pipeline: GPUDevice['createRenderPipeline'];
}
const hooks = new WeakMap<GPUDevice, Hook>();

/** Error scope around `call` when the device has them; the scope's message, or null. */
function scoped<T>(device: GPUDevice, call: () => T, sink: Promise<string | null>[]): T {
  if (typeof device.pushErrorScope !== 'function') return call();
  device.pushErrorScope('validation');
  try {
    return call();
  } finally {
    sink.push(
      device.popErrorScope().then(
        (e) => e?.message ?? null,
        () => null,
      ),
    );
  }
}

/** Starts noting the modules (and pipelines) `device` builds from `wgsl`. One wrapper per device, however many watch. */
function watch(device: GPUDevice, wgsl: string): () => Watch {
  let hook = hooks.get(device);
  if (!hook) {
    const h: Hook = {
      watches: new Set(),
      module: device.createShaderModule,
      pipeline: device.createRenderPipeline,
    };
    hooks.set(device, (hook = h));
    device.createShaderModule = function (this: GPUDevice, descriptor: GPUShaderModuleDescriptor) {
      const hits = [...h.watches].filter(
        (w) => typeof descriptor?.code === 'string' && descriptor.code.includes(w.wgsl),
      );
      if (!hits.length) return h.module.call(this, descriptor);
      const sink: Promise<string | null>[] = [],
        module = scoped(device, () => h.module.call(this, descriptor), sink);
      for (const w of hits) {
        w.modules.set(module, descriptor.code);
        w.scoped.push(...sink);
      }
      return module;
    };
    device.createRenderPipeline = function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor) {
      const hits = [...h.watches].filter(
        (w) =>
          w.modules.has(descriptor?.vertex?.module) || w.modules.has(descriptor?.fragment?.module as GPUShaderModule),
      );
      if (!hits.length) return h.pipeline.call(this, descriptor);
      const sink: Promise<string | null>[] = [],
        pipeline = scoped(device, () => h.pipeline.call(this, descriptor), sink);
      for (const w of hits) w.scoped.push(...sink);
      return pipeline;
    };
  }
  const w: Watch = { wgsl, modules: new Map(), scoped: [] },
    owner = hook;
  owner.watches.add(w);
  return () => {
    owner.watches.delete(w);
    // The wrappers stay as pass-throughs while another watch is open; the last one restores the device's own.
    if (!owner.watches.size) {
      device.createShaderModule = owner.module;
      device.createRenderPipeline = owner.pipeline;
      hooks.delete(device);
    }
    return w;
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Places a message from a module's text in the edited WGSL (appended verbatim by WgslMaterial). */
function place(code: string, wgsl: string, lineNum: number, linePos: number): [number, number] {
  const at = code.lastIndexOf(wgsl);
  if (at < 0 || !lineNum) return [0, 0];
  const first = code.slice(0, at).split('\n').length,
    line = lineNum - first + 1,
    column = line === 1 ? linePos - (at - code.lastIndexOf('\n', at - 1) - 1) : linePos;
  return line >= 1 && line <= wgsl.split('\n').length ? [line, Math.max(1, column)] : [0, 0];
}

/** Snapshot of a material's uniforms as constructor values (vectors as plain arrays). */
const uniformValues = (u: WgslMaterialShape['uniforms']) =>
  Object.fromEntries(Object.entries(u).map(([k, v]) => [k, typeof v === 'number' ? v : Array.from(v)]));

/** The module texts the device last built from each material's WGSL, for checking an edit before it is drawn. */
const built = new WeakMap<object, string[]>();
const hasDisplace = (wgsl: string) => /\bfn\s+displace\b/.test(wgsl);

/** Puts `material` on `mesh` and notes the modules the device builds from `wgsl` until one appears (or the timeout). */
async function draw(
  device: GPUDevice,
  mesh: ShaderMesh,
  material: unknown,
  wgsl: string,
  timeoutMs: number,
  settleMs: number,
): Promise<Watch> {
  const close = watch(device, wgsl),
    own = hooks.get(device)!;
  let w: Watch | undefined;
  try {
    mesh.material = material;
    const start = performance.now(),
      seen = () => [...own.watches].some((x) => x.wgsl === wgsl && x.modules.size);
    while (!seen() && performance.now() - start < timeoutMs) await wait(Math.min(16, timeoutMs));
    if (seen()) await wait(settleMs);
  } finally {
    w = close();
  }
  return w;
}

/** The compiler's messages for each module in `modules` (with its text), placed in `wgsl`, and any scope errors. */
async function diagnose(
  modules: Iterable<[GPUShaderModule, string]>,
  scopes: Promise<string | null>[],
  wgsl: string,
): Promise<ShaderDiagnostic[]> {
  const out: ShaderDiagnostic[] = [],
    seen = new Set<string>(),
    add = (d: ShaderDiagnostic) => {
      const key = `${d.type}:${d.line}:${d.column}:${d.message}`;
      if (!seen.has(key)) seen.add(key), out.push(d);
    };
  for (const [module, code] of modules) {
    const info = typeof module?.getCompilationInfo === 'function' ? await module.getCompilationInfo() : undefined;
    for (const m of info?.messages ?? []) {
      const [line, column] = place(code, wgsl, m.lineNum, m.linePos);
      add({ type: m.type, message: m.message, line, column });
    }
  }
  // A scope's message repeats a compile error already placed; it stands alone only when there is none.
  for (const message of await Promise.all(scopes))
    if (message && !out.some((d) => d.type === 'error')) add({ type: 'error', message, line: 0, column: 0 });
  return out;
}

/**
 * Swaps `mesh`'s WgslMaterial for one running `wgsl`, with the same uniforms, textures and other values, once the
 * device's compiler accepts it. The check compiles the module text the device built for the mesh's current WGSL with
 * the edit in its place (labelled `check-wgsl:inspector-shaders`), so a broken edit is never drawn: drawing an invalid
 * pipeline would invalidate the frame's commands. The first edit of a material draws one frame with a copy of it to
 * learn that text. A refused edit resolves `ok: false` with the messages, lines and columns counted in `wgsl`.
 *
 * ```ts
 * const result = await recompileShader(mesh, editedWgsl, { device: engine.gpu });
 * if (!result.ok) console.log(result.diagnostics);
 * ```
 */
export async function recompileShader(
  mesh: ShaderMesh,
  wgsl: string,
  options: RecompileOptions = {},
): Promise<ShaderEditResult> {
  const old = mesh?.material;
  if (!isWgslMaterial(old))
    throw new TypeError(
      'recompileShader needs a mesh drawing a WgslMaterial; pass a createMesh result whose material is a @margoengine/materials WgslMaterial',
    );
  if (typeof wgsl !== 'string') throw new TypeError('recompileShader needs WGSL text; pass a string');
  const { device = null, timeoutMs = 3000, settleMs = 50, history } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000)
    throw new RangeError('recompileShader timeoutMs must be 0 to 60000; pass a number of milliseconds in range');
  if (!Number.isFinite(settleMs) || settleMs < 0 || settleMs > timeoutMs)
    throw new RangeError('recompileShader settleMs must be 0 to timeoutMs; pass a smaller number of milliseconds');
  if (wgsl === old.wgsl) return { ok: true, modules: 0, diagnostics: [] };
  let next: WgslMaterialShape;
  try {
    const Material = old.constructor as new (options: object) => WgslMaterialShape;
    next = new Material({
      wgsl,
      shading: old.shading,
      uniforms: uniformValues(old.uniforms),
      textures: { ...old.textures },
    });
    next.copy(old);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    return { ok: false, modules: 0, diagnostics: [{ type: 'error', message, line: 0, column: 0 }] };
  }
  let modules = 0;
  if (device) {
    let codes = built.get(old);
    const copy = (old as { clone?: () => unknown }).clone;
    if (!codes && typeof copy === 'function') {
      // A copy is a new material to the drawing package, so it builds the current text again where it can be read.
      const probe = copy.call(old) as { dispose?: () => void };
      const seen = await draw(device, mesh, probe, old.wgsl, timeoutMs, settleMs);
      mesh.material = old;
      probe.dispose?.();
      built.set(old, (codes = [...new Set(seen.modules.values())]));
    }
    const checks = new Map<GPUShaderModule, string>(),
      scopes: Promise<string | null>[] = [];
    for (const code of codes ?? []) {
      const at = code.lastIndexOf(old.wgsl);
      if (at < 0) continue;
      // The drawn text calls displace() when the old WGSL had it; a stub keeps that call valid when the edit drops it.
      const stub =
          hasDisplace(old.wgsl) && !hasDisplace(wgsl)
            ? '\nfn displace(i: Input) -> vec3f { return vec3f(0.0); }\n'
            : '',
        text = code.slice(0, at) + wgsl + code.slice(at + old.wgsl.length) + stub;
      checks.set(
        scoped(device, () => device.createShaderModule({ label: 'check-wgsl:inspector-shaders', code: text }), scopes),
        text,
      );
    }
    const found = await diagnose(checks, scopes, wgsl);
    modules += checks.size;
    if (found.some((d) => d.type === 'error')) return { ok: false, modules, diagnostics: found };
    const drawn = await draw(device, mesh, next, wgsl, timeoutMs, settleMs),
      after = await diagnose(drawn.modules, drawn.scoped, wgsl);
    modules += drawn.modules.size;
    if (drawn.modules.size) built.set(next, [...new Set(drawn.modules.values())]);
    const diagnostics = [...found, ...after.filter((d) => !found.some((f) => f.message === d.message))];
    if (after.some((d) => d.type === 'error')) {
      mesh.material = old;
      return { ok: false, modules, diagnostics };
    }
    record(history, mesh, old, next);
    return { ok: true, modules, diagnostics };
  }
  mesh.material = next;
  record(history, mesh, old, next);
  return { ok: true, modules, diagnostics: [] };
}

function record(history: EditHistory | undefined, mesh: ShaderMesh, old: unknown, next: unknown): void {
  history?.record({
    label: 'Edit shader',
    undo: () => (mesh.material = old),
    redo: () => (mesh.material = next),
  });
}

/** `ShaderEditor` options. */
export interface ShaderEditorOptions {
  /** The meshes to offer, or a function listing them (called on `refresh`). Meshes not drawing a WgslMaterial are left out. */
  meshes?: readonly ShaderMesh[] | (() => readonly ShaderMesh[]);
  /** Element for the panel. Default `document.body`. */
  parent?: HTMLElement;
  /** Undo history (pass `inspector.history` to share the Inspector's). Default a new one. */
  history?: EditHistory;
  /** Apply after each pause in typing. Default true. */
  live?: boolean;
  /** The pause, in milliseconds, 0 to 10,000. Default 400. */
  delayMs?: number;
  /** Passed to `recompileShader`. Default 3,000. */
  timeoutMs?: number;
}

const css = `
:host{position:fixed;right:12px;bottom:12px;width:min(520px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;z-index:10001;display:block;color:#202226;background:#fafbfc;border:1px solid #b9bec7;border-radius:4px;font:12px/1.4 system-ui;letter-spacing:0}
*{box-sizing:border-box}h2{font-size:14px;margin:0;padding:10px 12px;border-bottom:1px solid #d5d9df}.row{display:flex;gap:8px;align-items:center;padding:6px 12px}
select{flex:1;min-width:0;font:inherit}textarea{display:block;width:calc(100% - 24px);margin:0 12px;min-height:220px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;tab-size:2;white-space:pre;resize:vertical}
button{font:inherit}.status{color:#5d636b}.status[data-state=error]{color:#b42318}ol{margin:4px 12px 10px;padding-left:20px;color:#b42318;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace}
`;

/**
 * A DOM panel that edits the WGSL of each mesh drawing a `@margoengine/materials` WgslMaterial and recompiles it in
 * place: `ShaderEditor.attach(engine, { meshes: [mesh] })`. Typing applies after a pause (`live`), compiler errors
 * list under the text with their line, and a failed edit leaves the mesh drawing its last good shader.
 */
export class ShaderEditor implements EnginePlugin {
  readonly name = 'inspector:shaders';
  readonly element: HTMLElement;
  readonly history: EditHistory;
  private engine?: Engine;
  private readonly options: ShaderEditorOptions;
  private readonly select: HTMLSelectElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLOListElement;
  private items: ShaderMesh[] = [];
  private current = -1;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<ShaderEditResult> = Promise.resolve({ ok: true, modules: 0, diagnostics: [] });
  private disposed = false;
  private applying = false;
  private readonly unlisten: () => void;
  /** The last result shown. */
  result?: ShaderEditResult;

  static attach(engine: EngineKernel, options: ShaderEditorOptions = {}): ShaderEditor {
    const editor = new ShaderEditor(options);
    engineRuntime(engine).use(editor);
    return editor;
  }
  constructor(options: ShaderEditorOptions = {}) {
    const delay = options.delayMs ?? 400;
    if (!Number.isFinite(delay) || delay < 0 || delay > 10000)
      throw new RangeError('ShaderEditor delayMs must be 0 to 10000; pass a number of milliseconds in range');
    this.options = options;
    this.history = options.history ?? new EditHistory();
    const parent = options.parent ?? document.body,
      doc = parent.ownerDocument;
    this.element = doc.createElement('div');
    this.element.dataset.margoShaderEditor = '';
    const root = this.element.attachShadow({ mode: 'open' }),
      style = doc.createElement('style'),
      title = doc.createElement('h2'),
      top = doc.createElement('div'),
      bottom = doc.createElement('div'),
      apply = doc.createElement('button');
    style.textContent = css;
    title.textContent = 'Shaders';
    top.className = bottom.className = 'row';
    this.select = doc.createElement('select');
    this.select.setAttribute('aria-label', 'Mesh');
    this.textarea = doc.createElement('textarea');
    this.textarea.spellcheck = false;
    this.textarea.setAttribute('aria-label', 'WGSL');
    apply.textContent = 'Apply';
    this.status = doc.createElement('span');
    this.status.className = 'status';
    this.status.setAttribute('role', 'status');
    this.list = doc.createElement('ol');
    top.append(this.select);
    bottom.append(apply, this.status);
    root.append(style, title, top, this.textarea, bottom, this.list);
    parent.append(this.element);
    this.select.addEventListener('change', () => this.show(Number(this.select.value)));
    apply.addEventListener('click', () => void this.apply());
    this.textarea.addEventListener('input', () => {
      if (this.options.live === false) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.apply(), delay);
    });
    // Undo and redo swap the material back: show the WGSL the mesh draws now.
    this.unlisten = this.history.onChange(() => {
      if (!this.applying) this.show(this.current);
    });
    this.refresh();
  }
  setup(engine: Engine): void {
    if (this.disposed || this.engine)
      throw margoError('attached', 'ShaderEditor is disposed or already attached; create a new ShaderEditor');
    this.engine = engine;
  }
  /** The meshes offered now (those drawing a WgslMaterial). */
  get meshes(): readonly ShaderMesh[] {
    return this.items;
  }
  /** The WGSL in the editor. */
  get text(): string {
    return this.textarea.value;
  }
  set text(value: string) {
    this.textarea.value = value;
  }
  /** Adds a mesh to the list (no effect when listed or not drawing a WgslMaterial) and returns its index, or -1. */
  add(mesh: ShaderMesh): number {
    if (!isWgslMaterial(mesh?.material)) return -1;
    if (!this.items.includes(mesh)) {
      this.items.push(mesh);
      this.options.meshes = [...this.items];
      this.fill();
    }
    if (this.current < 0) this.show(0);
    return this.items.indexOf(mesh);
  }
  /** Lists the meshes again from `options.meshes`. */
  refresh(): void {
    const given = this.options.meshes,
      list = typeof given === 'function' ? given() : (given ?? []),
      keep = this.items[this.current];
    this.items = list.filter((m) => isWgslMaterial(m?.material));
    this.fill();
    const at = keep ? this.items.indexOf(keep) : -1;
    this.show(at >= 0 ? at : this.items.length ? 0 : -1);
  }
  /** Shows mesh `index`'s WGSL (its material's current text). */
  show(index: number): void {
    if (index >= this.items.length) throw new RangeError(`No mesh ${index}; pick an index below ${this.items.length}`);
    this.current = index;
    this.select.value = String(index);
    const material = this.items[index]?.material;
    this.textarea.value = isWgslMaterial(material) ? material.wgsl : '';
    this.textarea.disabled = index < 0;
  }
  /**
   * Recompiles the selected mesh with `wgsl` (default: the editor's text) and shows the outcome. Edits run one at a
   * time in order; each resolves with its own result.
   */
  apply(wgsl: string = this.textarea.value): Promise<ShaderEditResult> {
    clearTimeout(this.timer);
    const mesh = this.items[this.current];
    if (!mesh)
      return Promise.reject(new RangeError('ShaderEditor has no mesh selected; add a WgslMaterial mesh first'));
    const run = async () => {
      if (this.disposed) return { ok: false, modules: 0, diagnostics: [] };
      this.status.textContent = 'Compiling';
      this.status.dataset.state = 'busy';
      this.applying = true;
      let result: ShaderEditResult;
      try {
        result = await recompileShader(mesh, wgsl, {
          device: this.engine?.gpu ?? null,
          history: this.history,
          timeoutMs: this.options.timeoutMs,
          settleMs: Math.min(50, this.options.timeoutMs ?? 3000),
        });
      } finally {
        this.applying = false;
      }
      if (!this.disposed) this.report(result);
      return result;
    };
    return (this.pending = this.pending.then(run, run));
  }
  private report(result: ShaderEditResult): void {
    this.result = result;
    const errors = result.diagnostics.filter((d) => d.type === 'error');
    this.status.dataset.state = result.ok ? 'ok' : 'error';
    this.status.textContent = !result.ok
      ? `${errors.length} error${errors.length === 1 ? '' : 's'}; the mesh keeps its last good shader`
      : result.modules
        ? 'Compiled'
        : 'Applied; not drawn yet';
    const doc = this.element.ownerDocument;
    this.list.replaceChildren(
      ...result.diagnostics.map((d) => {
        const li = doc.createElement('li');
        li.textContent = `${d.line ? `${d.line}:${d.column} ` : ''}${d.type}: ${d.message}`;
        return li;
      }),
    );
  }
  private fill(): void {
    const doc = this.element.ownerDocument;
    this.select.replaceChildren(
      ...this.items.map((mesh, i) => {
        const option = doc.createElement('option');
        option.value = String(i);
        option.textContent = mesh.name || `Mesh ${i + 1}`;
        return option;
      }),
    );
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.unlisten();
    this.element.remove();
    this.items = [];
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
