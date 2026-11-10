/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type Mesh,
  type PassContext,
} from '@margoengine/core/extension';
import { Lines, Line, BoxHelper, VertexNormalsHelper, LightsHelper } from '@margoengine/lines';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { margoError } from '../../shared/errors.js';
import { meshData, wireframe } from './debug-geometry.js';
import { inView } from '../../shared/view-rect.js';
import { EditHistory } from './history.js';
import { editorDeleted } from './edit-state.js';
import { hexOf } from './color.js';
import { restoreSnapshot, snapshotMeshes, type RestoreResult, type SceneSnapshot } from './snapshot.js';
import { describeEngine, type EngineResources } from './resources.js';
export { EditHistory, type Edit } from './history.js';
export {
  snapshotMeshes,
  restoreSnapshot,
  parseSnapshot,
  type MeshSnapshot,
  type SceneSnapshot,
  type RestoreResult,
} from './snapshot.js';
export { describeEngine, type EngineResources } from './resources.js';

/** Options of the Inspector: the parent element for its panel and the effect options it edits. */
export interface InspectorOptions {
  parent?: HTMLElement;
  /** Mutable options of an attached PostProcessing/Tonemap effect. */
  effects?: { exposure?: number; bloom?: number };
  /**
   * Click an object in the canvas to select it (a click, not a drag: a move of more than 4 px is left to the camera
   * controls). Default true.
   */
  pick?: boolean;
  /** Most edits the undo history keeps, 1 to 100,000. Default 200. */
  historyLimit?: number;
  /** Tree label of an entity without a name, such as the component that made it. Default `Entity <id>`. */
  label?: (mesh: Mesh) => string | undefined;
}
type Mode = 'wireframe' | 'normals' | 'bounds' | 'lights';
interface DebugLines {
  geometry: object;
  wireframe?: Line;
  normals?: Line;
  bounds?: Line;
}
const css = `
:host{position:fixed;right:12px;top:12px;width:280px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);z-index:10001;display:block;color:#202226;font:12px/1.4 system-ui;letter-spacing:0}
@media(max-width:560px){:host{top:150px;max-height:calc(100dvh - 162px)}section{max-height:calc(100dvh - 162px)!important}}
*{box-sizing:border-box}section{background:#fafbfc;border:1px solid #b9bec7;border-radius:4px;max-height:calc(100dvh - 24px);overflow:auto}
h2{font-size:14px;margin:0;padding:10px 12px;border-bottom:1px solid #d5d9df}fieldset{border:0;border-bottom:1px solid #d5d9df;padding:10px 12px;margin:0}legend{padding:6px 0 0;font-weight:600}
label{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}input{max-width:100%;min-width:0;font:inherit}input[type=number]{width:72px}input[type=text]{width:156px}input[type=range]{width:132px;accent-color:#087e67}input[type=checkbox]{accent-color:#087e67}
button{font:inherit;border:0;background:none;color:inherit;cursor:pointer}button:focus-visible,[role=treeitem]:focus-visible{outline:2px solid #087e67;outline-offset:-2px}
[role=tree]{max-height:220px;overflow:auto;padding:6px 0}.row{display:flex;align-items:center;min-height:28px;padding-right:8px}.row button{flex:none;width:24px;height:24px;padding:0}.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[aria-selected=true]>.row{background:#d6eee7;color:#084f40}.muted{opacity:.55}[role=group]{padding-left:12px}.axes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.axes label{display:block}.axes input{width:100%}input:disabled{opacity:.5}
fieldset.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}fieldset.bar button{border:1px solid #b9bec7;border-radius:3px;padding:3px 9px;background:#fff}button:disabled{opacity:.45;cursor:default}input[type=color]{width:48px;height:24px;padding:0}input[data-search]{flex:1 1 100%;width:auto}.status{flex:1 1 100%;min-height:1.4em;color:#555}details{border-bottom:1px solid #d5d9df;padding:6px 12px}summary{cursor:pointer;font-weight:600}pre{margin:6px 0 0;max-height:240px;overflow:auto;white-space:pre-wrap;font:11px/1.35 ui-monospace,monospace;user-select:text}
`;

/**
 * A DOM panel with a scene tree, frame statistics and debug overlays (wireframe, normals, bounds, lights). Install it as an engine plugin; dispose it to remove the panel.
 */
export class Inspector implements EnginePlugin {
  readonly name = 'inspector';
  readonly element: HTMLDivElement;
  readonly root: ShadowRoot;
  readonly debug = { wireframe: false, normals: false, bounds: false, lights: false };
  private engine?: Engine;
  private selection: Mesh | null = null;
  private readonly lines = new Lines({ name: 'inspector:lines' });
  private readonly helpers = new Map<Mesh, DebugLines>();
  private lightLines?: LightsHelper;
  /** Core's sun as a directional light shape (direction it travels, colour), and the lights gathered each frame. */
  private readonly sun = { direction: [0, -1, 0], color: [1, 1, 1] };
  private readonly sceneLights: unknown[] = [];
  private readonly collapsed = new Set<Mesh>();
  private readonly items = new Map<Mesh, HTMLElement>();
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly tree: HTMLDivElement;
  private readonly effects?: InspectorOptions['effects'];
  private signature = '';
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  /** Every edit made in the panel, undoable with `undo()` / Ctrl+Z. */
  readonly history: EditHistory;
  private readonly pickEnabled: boolean;
  private readonly label?: (mesh: Mesh) => string | undefined;
  private query = '';
  private shader = '';
  private pickCount = 0;
  private stopPicking?: () => void;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly details = new Map<string, HTMLDetailsElement>();
  private readonly outputs = new Map<string, HTMLElement>();

  constructor({ parent = document.body, effects, pick = true, historyLimit = 200, label }: InspectorOptions = {}) {
    this.label = label;
    if (typeof pick !== 'boolean') throw new TypeError('Inspector pick must be true or false; pass a boolean');
    this.history = new EditHistory(historyLimit);
    this.pickEnabled = pick;
    this.effects = effects;
    const doc = parent.ownerDocument;
    this.element = doc.createElement('div');
    this.element.dataset.margoInspector = '';
    this.root = this.element.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = css;
    const panel = doc.createElement('section'),
      title = doc.createElement('h2');
    title.textContent = 'Inspector';
    panel.append(title);
    this.root.append(style, panel);
    const bar = doc.createElement('fieldset'),
      file = doc.createElement('input'),
      search = doc.createElement('input'),
      status = doc.createElement('div');
    bar.className = 'bar';
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.hidden = true;
    file.setAttribute('aria-label', 'Load scene file');
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (chosen)
        chosen
          .text()
          .then((text) => this.report(() => this.restore(JSON.parse(text))))
          .catch((error) => this.say(String(error)));
    });
    for (const [id, text, run] of [
      ['undo', 'Undo', () => this.undo()],
      ['redo', 'Redo', () => this.redo()],
      ['save', 'Save', () => this.download()],
      ['load', 'Load', () => file.click()],
    ] as const) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.dataset.action = id;
      button.addEventListener('click', () => this.report(run));
      this.buttons.set(id, button);
      bar.append(button);
    }
    search.type = 'text';
    search.placeholder = 'Search entities';
    search.setAttribute('aria-label', 'Search entities');
    search.dataset.search = '';
    search.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.signature = '';
      this.refresh();
    });
    status.setAttribute('role', 'status');
    status.className = 'status';
    this.outputs.set('status', status);
    bar.append(file, search, status);
    panel.append(bar);
    this.element.addEventListener('keydown', (event) => this.shortcut(event));
    this.history.onChange(() => this.refresh());
    const modes = doc.createElement('fieldset');
    for (const [key, text] of [
      ['wireframe', 'Wireframe'],
      ['normals', 'Vertex normals'],
      ['bounds', 'AABB bounds'],
      ['lights', 'Light helpers'],
    ] as const) {
      const input = this.input(modes, key, text, 'checkbox');
      input.addEventListener('change', () => this.setDebug(key, input.checked));
    }
    panel.append(modes);
    this.tree = doc.createElement('div');
    this.tree.setAttribute('role', 'tree');
    this.tree.setAttribute('aria-label', 'Scene entities');
    panel.append(this.tree);
    this.tree.addEventListener('keydown', (event) => this.keydown(event));
    const properties = doc.createElement('fieldset'),
      legend = doc.createElement('legend');
    legend.textContent = 'Entity';
    properties.append(legend);
    const name = this.input(properties, 'name', 'Name', 'text');
    name.addEventListener('change', () => {
      if (this.liveSelection()) {
        this.commit(
          'Rename',
          'name',
          (m) => m.name,
          (m, v) => (m.name = v),
          name.value,
        );
        this.refresh();
      }
    });
    const visible = this.input(properties, 'visible', 'Visible', 'checkbox');
    visible.addEventListener('change', () => {
      if (this.liveSelection())
        this.commit(
          'Set visible',
          'visible',
          (m) => m.visible,
          (m, v) => (m.visible = v),
          visible.checked,
        );
    });
    for (const kind of ['position', 'rotation', 'scale'] as const) {
      const label = doc.createElement('div');
      label.textContent = kind[0].toUpperCase() + kind.slice(1);
      properties.append(label);
      const axes = doc.createElement('div');
      axes.className = 'axes';
      properties.append(axes);
      for (const axis of ['x', 'y', 'z'] as const) {
        const input = this.input(axes, `${kind}.${axis}`, axis.toUpperCase(), 'number');
        input.step = '0.01';
        input.setAttribute('aria-label', `${kind} ${axis}`);
        input.addEventListener('change', () =>
          this.edit(input, () => {
            if (this.liveSelection())
              this.commit(
                `Set ${kind} ${axis}`,
                `${kind}.${axis}`,
                (m) => m[kind][axis],
                (m, v) => (m[kind][axis] = v),
                input.valueAsNumber,
              );
          }),
        );
      }
    }
    for (const [key, label, slot, min] of [
      ['roughness', 'Roughness', 4, 0.045],
      ['metallic', 'Metallic', 5, 0],
    ] as const) {
      const input = this.input(properties, key, label, 'range');
      input.min = String(min);
      input.max = '1';
      input.step = '0.005';
      input.value = key === 'roughness' ? '0.5' : '0';
      input.addEventListener('input', () =>
        this.edit(input, () => {
          const value = input.valueAsNumber;
          if (!Number.isFinite(value) || value < min || value > 1)
            throw new RangeError('Invalid material value; pass a finite number in the control range');
          if (this.liveSelection())
            this.commit(
              `Set ${key}`,
              key,
              (m) => m.material.data[slot],
              (m, v) => (m.material.data[slot] = v),
              value,
            );
        }),
      );
    }
    const color = this.input(properties, 'color', 'Colour', 'color');
    color.addEventListener('input', () =>
      this.edit(color, () => {
        if (this.liveSelection())
          this.commit(
            'Set colour',
            'color',
            (m) => hexOf(m.material.data),
            (m, v) => m.material.set({ color: v }),
            color.value,
          );
      }),
    );
    const sided = this.input(properties, 'doubleSided', 'Double sided', 'checkbox');
    sided.addEventListener('change', () =>
      this.edit(sided, () => {
        if (this.liveSelection())
          this.commit(
            'Set double sided',
            'doubleSided',
            (m) => !!m.material.data[6],
            (m, v) => m.material.set({ doubleSided: v }),
            sided.checked,
          );
      }),
    );
    panel.append(properties);
    const grading = doc.createElement('fieldset'),
      gradeTitle = doc.createElement('legend');
    gradeTitle.textContent = 'Effects';
    grading.append(gradeTitle);
    for (const [key, label, min, max] of [
      ['exposure', 'Exposure', -10, 10],
      ['bloom', 'Bloom', 0, 4],
    ] as const) {
      const input = this.input(grading, key, label, 'range');
      input.min = String(min);
      input.max = String(max);
      input.step = '0.05';
      input.value = String(this.effects?.[key] ?? 0);
      input.addEventListener('input', () =>
        this.edit(input, () => {
          const value = input.valueAsNumber;
          if (!Number.isFinite(value) || value < min || value > max)
            throw new RangeError('Invalid effect value; pass a finite, non-negative number');
          const effects = this.effects;
          if (effects) {
            const old = effects[key] ?? 0;
            effects[key] = value;
            this.history.record({
              label: `Set ${key}`,
              key: `effect.${key}`,
              undo: () => (effects[key] = old),
              redo: () => (effects[key] = value),
            });
          }
        }),
      );
    }
    panel.append(grading);
    for (const [id, title] of [
      ['resources', 'Resources'],
      ['shader', 'Scene shader (WGSL)'],
    ] as const) {
      const details = doc.createElement('details'),
        summary = doc.createElement('summary'),
        output = doc.createElement('pre');
      details.dataset.section = id;
      summary.textContent = title;
      output.dataset.output = id;
      details.append(summary, output);
      details.addEventListener('toggle', () => this.refresh());
      this.details.set(id, details);
      this.outputs.set(id, output);
      panel.append(details);
    }
    parent.append(this.element);
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 250);
  }

  static attach(engine: EngineKernel, options: InspectorOptions = {}): Inspector {
    const inspector = new Inspector(options);
    try {
      engineRuntime(engine).use(inspector);
      return inspector;
    } catch (error) {
      inspector.dispose();
      throw error;
    }
  }
  get selected(): MeshHandle | null {
    return this.selection;
  }

  select(handle: MeshHandle | null): void {
    if (this.disposed || !this.engine)
      throw margoError('state', 'Inspector is not attached; install it on an engine first');
    const mesh = handle ? meshRuntime(handle) : null;
    if (mesh) {
      mesh.check();
      if (mesh.engine !== this.engine)
        throw new TypeError('Mesh belongs to another engine; select a mesh created by this engine');
    }
    this.choose(mesh);
  }

  private choose(mesh: Mesh | null): void {
    this.selection = mesh;
    if (mesh)
      for (let id = this.engine!.store.parents[mesh.id]; id !== -1; id = this.engine!.store.parents[id])
        this.collapsed.delete(this.engine!.meshes.get(id)!);
    this.signature = '';
    this.refresh();
  }

  /**
   * Applies a change to the selected mesh and records it for undo. Changes with one `key` made within 800 ms of each
   * other (a slider drag) undo as one step. A value the engine rejects throws before anything is recorded.
   */
  private commit<T>(
    label: string,
    key: string,
    get: (mesh: Mesh) => T,
    set: (mesh: Mesh, value: T) => void,
    value: T,
  ): void {
    const mesh = this.selection!,
      old = get(mesh),
      engine = this.engine!;
    set(mesh, value);
    const live = () => engine.meshes.get(mesh.id) === mesh;
    this.history.record({
      label,
      key: `${mesh.id}.${key}`,
      undo: () => live() && set(mesh, old),
      redo: () => live() && set(mesh, value),
    });
  }

  /** Takes back the latest edit made in the panel; false when there is none. */
  undo(): boolean {
    this.alive();
    return this.history.undo();
  }
  /** Does the latest undone edit again; false when there is none. */
  redo(): boolean {
    this.alive();
    return this.history.redo();
  }
  private alive(): void {
    if (this.disposed) throw margoError('disposed', 'Inspector is disposed; create a new Inspector');
  }

  /**
   * The scene as plain JSON (names, visibility, transforms, core PBR material values) for the inspector's scene. Save
   * it with `JSON.stringify` and give it to `restore` later; the panel's Save button downloads it.
   * @throws MargoError `'state'` when the inspector is not attached, `'disposed'` after `dispose()`.
   */
  snapshot(): SceneSnapshot {
    this.alive();
    if (!this.engine) throw margoError('state', 'Inspector is not attached; install it on an engine first');
    return snapshotMeshes(this.engine, this.meshes());
  }
  /**
   * Puts a snapshot's values back on the meshes with the same ids, as one undoable edit. The snapshot is checked first,
   * so a bad one changes nothing.
   * @throws TypeError / RangeError for a malformed snapshot, MargoError `'state'` when not attached.
   */
  restore(snapshot: unknown): RestoreResult {
    this.alive();
    const engine = this.engine;
    if (!engine) throw margoError('state', 'Inspector is not attached; install it on an engine first');
    const before = snapshotMeshes(engine, this.meshes()),
      result = restoreSnapshot(engine, snapshot),
      after = snapshotMeshes(engine, this.meshes());
    this.history.record({
      label: 'Load scene',
      undo: () => void restoreSnapshot(engine, before),
      redo: () => void restoreSnapshot(engine, after),
    });
    this.signature = '';
    this.say(
      `Loaded ${result.applied} entities` +
        (result.missing.length ? `, ${result.missing.length} not in this scene` : ''),
    );
    return result;
  }
  /** Counts of what the engine draws (meshes, geometries, materials, triangles) and its plugins. */
  resources(): EngineResources {
    this.alive();
    if (!this.engine) throw margoError('state', 'Inspector is not attached; install it on an engine first');
    return describeEngine(this.engine, this.meshes());
  }
  /** The scene's WGSL from the latest WebGPU frame, or an empty string before one has drawn. */
  get shaderSource(): string {
    return this.shader;
  }
  private download(): void {
    const doc = this.element.ownerDocument,
      url = URL.createObjectURL(new Blob([JSON.stringify(this.snapshot(), null, 2)], { type: 'application/json' })),
      link = doc.createElement('a');
    link.href = url;
    link.download = 'scene.json';
    link.click();
    URL.revokeObjectURL(url);
  }
  private say(text: string): void {
    const out = this.outputs.get('status');
    if (out) out.textContent = text;
  }
  /** Runs a panel action; a failure shows in the status line instead of escaping from an event handler. */
  private report(run: () => unknown): void {
    try {
      run();
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
    }
  }
  private shortcut(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const target = event.target as HTMLElement,
      typing = target.tagName === 'INPUT' && ['text', 'number', 'search'].includes((target as HTMLInputElement).type);
    const key = event.key.toLowerCase();
    // In a text field the browser's own undo edits the text; elsewhere the shortcut undoes panel edits.
    if (typing || this.disposed) return;
    if (key === 'z' && !event.shiftKey) this.report(() => this.undo());
    else if ((key === 'z' && event.shiftKey) || key === 'y') this.report(() => this.redo());
    else return;
    event.preventDefault();
  }
  // A click, not a drag: orbit and fly controls move the pointer, so only a near-still press selects.
  private watchPicks(engine: Engine): () => void {
    const canvas = engine.canvas;
    // An OffscreenCanvas or a stand-in has no pointer events or element rectangle: nothing to click, so no picking.
    if (typeof canvas?.addEventListener !== 'function' || typeof canvas.getBoundingClientRect !== 'function')
      return () => {};
    let down: { x: number; y: number } | undefined;
    const press = (event: PointerEvent) => {
      down = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
    };
    const release = (event: PointerEvent) => {
      const start = down;
      down = undefined;
      if (!start || event.defaultPrevented || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const box = canvas.getBoundingClientRect(),
        ticket = ++this.pickCount;
      engine
        .pick(event.clientX - box.left, event.clientY - box.top)
        .then((mesh) => {
          if (ticket === this.pickCount && !this.disposed && this.engine === engine) this.choose(mesh);
        })
        .catch((error) => {
          if (!this.disposed && !engine.disposed) reportError(error);
        });
    };
    canvas.addEventListener('pointerdown', press);
    canvas.addEventListener('pointerup', release);
    return () => {
      canvas.removeEventListener('pointerdown', press);
      canvas.removeEventListener('pointerup', release);
    };
  }

  setDebug(mode: Mode, enabled: boolean): void {
    if (this.disposed) throw margoError('disposed', 'Inspector is disposed; create a new Inspector');
    if (!Object.hasOwn(this.debug, mode) || typeof enabled !== 'boolean')
      throw new TypeError('Invalid debug mode; use wireframe, normals, bounds or lights');
    if (enabled && this.engine?.backend !== 'webgpu')
      throw margoError('unsupported', 'Debug rendering requires WebGPU; use a browser that supports it');
    this.debug[mode] = enabled;
    this.inputs.get(mode)!.checked = enabled;
  }

  setup(engine: Engine): void {
    if (this.disposed || this.engine)
      throw margoError('attached', 'Inspector is disposed or already attached; create a new Inspector for this engine');
    this.engine = engine;
    if (this.pickEnabled) this.stopPicking = this.watchPicks(engine);
    if (engine.backend === 'webgpu') this.lines.setup(engine);
    this.refresh();
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'inspector:sync',
      order: 19,
      execute: (c) => {
        if (c.backend === 'webgpu' && typeof c.shader === 'string') this.shader = c.shader;
        this.syncDebug(c);
      },
    });
    this.lines.registerPasses(graph);
  }

  /** The meshes of the scene this inspector is attached to (the default scene unless attached with `scene.use`). */
  private *meshes(): IterableIterator<Mesh> {
    const engine = this.engine!;
    for (const mesh of (engine.sceneOf(this) ?? engine.scene).meshes.values()) if (!editorDeleted.has(mesh)) yield mesh;
  }
  // Runs in every view: helpers show for the meshes that view draws (its culling and layers).
  private syncDebug(c: PassContext): void {
    const engine = this.engine!;
    if (this.debug.lights && !this.lightLines && engine.backend === 'webgpu')
      this.lightLines = this.lines.add(new LightsHelper(() => this.gatherLights(), { onTop: true, size: 0.25 }));
    if (this.lightLines) this.lightLines.visible = this.debug.lights;
    if (!this.helpers.size && !this.debug.wireframe && !this.debug.normals && !this.debug.bounds) return;
    for (const [mesh, helpers] of this.helpers)
      if (engine.meshes.get(mesh.id) !== mesh || meshData(mesh)?.identity !== helpers.geometry) {
        helpers.wireframe?.dispose();
        helpers.normals?.dispose();
        helpers.bounds?.dispose();
        this.helpers.delete(mesh);
      }
    if (engine.backend !== 'webgpu') return;
    for (const mesh of this.meshes()) {
      const source = meshData(mesh);
      if (!source) continue;
      let helpers = this.helpers.get(mesh);
      if (!helpers && (this.debug.wireframe || this.debug.normals || this.debug.bounds)) {
        helpers = { geometry: source.identity };
        this.helpers.set(mesh, helpers);
      }
      if (!helpers) continue;
      for (const mode of ['wireframe', 'normals', 'bounds'] as const) {
        if (this.debug[mode] && !helpers[mode])
          helpers[mode] = this.lines.add(
            mode === 'wireframe'
              ? wireframe(mesh)
              : mode === 'normals'
                ? new VertexNormalsHelper(mesh, { size: source.radius * 0.15, color: '#ed6b86', onTop: true })
                : new BoxHelper(mesh, { color: '#e4ba31', onTop: true }),
          );
        // Core's culling sphere is empty on a loader-owned PBR node. Its origin
        // can be outside the frustum while the primitive still crosses the edge.
        if (helpers[mode])
          helpers[mode]!.visible =
            this.debug[mode] &&
            inView(c, mesh) &&
            (source.pbr ? meshWorldMatrix(engine, mesh) !== null : !!engine.store.visible[mesh.id]);
      }
    }
  }

  // Lights by shape, without importing their packages: core's sun, the `list` of clustered's plugins (point and spot,
  // directional and area lights) and an environment hemisphere or ambient light. LightsHelper skips anything else.
  private gatherLights(): readonly unknown[] {
    const engine = this.engine!,
      out = this.sceneLights,
      { direction, radiance } = engine.lighting;
    out.length = 0;
    if (direction[3] > 0) {
      for (let k = 0; k < 3; k++) {
        this.sun.direction[k] = -direction[k];
        this.sun.color[k] = radiance[k];
      }
      out.push(this.sun);
    }
    for (const plugin of engine.plugins.values()) {
      const list = (plugin as { list?: unknown }).list;
      if (plugin.name.startsWith('clustered') && Array.isArray(list)) for (const light of list) out.push(light);
      else if (plugin.name.startsWith('environment:') && 'sky' in plugin) out.push(plugin);
    }
    return out;
  }

  private input(parent: HTMLElement, key: string, text: string, type: string): HTMLInputElement {
    const doc = this.element.ownerDocument,
      label = doc.createElement('label'),
      span = doc.createElement('span'),
      input = doc.createElement('input');
    span.textContent = text;
    input.type = type;
    input.dataset.property = key;
    label.append(span, input);
    parent.append(label);
    this.inputs.set(key, input);
    return input;
  }
  private liveSelection(): boolean {
    return (
      !!this.selection &&
      !editorDeleted.has(this.selection) &&
      this.engine?.meshes.get(this.selection.id) === this.selection
    );
  }
  private edit(input: HTMLInputElement, action: () => void): void {
    try {
      action();
      input.setCustomValidity('');
    } catch (error) {
      input.setCustomValidity(String(error));
    }
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    const engine = this.engine;
    if (this.selection && !this.liveSelection()) this.selection = null;
    let signature = '',
      replaced = false;
    if (engine && !engine.disposed)
      for (const mesh of this.meshes()) {
        signature += JSON.stringify([
          mesh.id,
          mesh.name,
          engine.store.parents[mesh.id],
          mesh.visible,
          mesh === this.selection,
          this.collapsed.has(mesh),
        ]);
        if (!this.items.has(mesh)) replaced = true;
      }
    if (signature !== this.signature || replaced) {
      const focused = this.tree.contains(this.root.activeElement);
      this.signature = signature;
      this.tree.replaceChildren();
      this.items.clear();
      for (const mesh of [...this.collapsed]) if (engine?.meshes.get(mesh.id) !== mesh) this.collapsed.delete(mesh);
      if (engine) {
        const groups = new Map<number, HTMLElement>(),
          doc = this.element.ownerDocument;
        for (const mesh of this.meshes()) {
          const item = doc.createElement('div'),
            row = doc.createElement('div'),
            name = doc.createElement('span'),
            group = doc.createElement('div');
          item.setAttribute('role', 'treeitem');
          item.setAttribute('aria-selected', String(mesh === this.selection));
          item.tabIndex = mesh === this.selection ? 0 : -1;
          item.dataset.entity = String(mesh.id);
          row.className = 'row';
          name.className = 'name';
          name.textContent = mesh.name || this.label?.(mesh) || `Entity ${mesh.id}`;
          if (!mesh.visible) name.classList.add('muted');
          row.addEventListener('click', () => {
            this.select(mesh);
            this.items.get(mesh)?.focus();
          });
          group.setAttribute('role', 'group');
          group.hidden = this.collapsed.has(mesh);
          row.append(name);
          item.append(row, group);
          groups.set(mesh.id, group);
          this.items.set(mesh, item);
        }
        for (const [mesh, item] of this.items) {
          const parent = engine.store.parents[mesh.id];
          (groups.get(parent) ?? this.tree).append(item);
        }
        for (const [mesh, item] of this.items) {
          const group = groups.get(mesh.id)!;
          if (group.childElementCount) {
            const button = doc.createElement('button');
            button.type = 'button';
            button.tabIndex = -1;
            button.textContent = this.collapsed.has(mesh) ? '+' : '-';
            button.setAttribute('aria-label', `Toggle ${mesh.name || 'entity'} children`);
            item.setAttribute('aria-expanded', String(!group.hidden));
            button.addEventListener('click', (event) => {
              event.stopPropagation();
              this.toggle(mesh);
            });
            item.firstElementChild!.prepend(button);
          }
        }
        if (this.query) {
          const show = new Set<Mesh>();
          for (const mesh of this.items.keys())
            if ((mesh.name || `Entity ${mesh.id}`).toLowerCase().includes(this.query))
              for (let m: Mesh | undefined = mesh; m && !show.has(m); m = engine.meshes.get(engine.store.parents[m.id]))
                show.add(m);
          for (const [mesh, item] of this.items) item.hidden = !show.has(mesh);
        }
        const first = this.tree.querySelector<HTMLElement>('[role=treeitem]:not([hidden])');
        if (first && !this.selection) first.tabIndex = 0;
      }
      if (focused)
        (this.selection
          ? this.items.get(this.selection)
          : this.tree.querySelector<HTMLElement>('[role=treeitem]')
        )?.focus();
    }
    for (const [key, input] of this.inputs) {
      if (key in this.debug) {
        input.disabled = engine?.backend !== 'webgpu';
        continue;
      }
      const effect = key === 'exposure' || key === 'bloom';
      input.disabled = effect ? !this.effects || !(key in this.effects) : !this.liveSelection();
      if (this.root.activeElement === input || input.disabled) continue;
      if (effect) input.value = String(this.effects![key as 'exposure' | 'bloom'] ?? 0);
      else if (key === 'name') input.value = this.selection!.name;
      else if (key === 'visible') input.checked = this.selection!.visible;
      else if (key === 'color') input.value = hexOf(this.selection!.material.data);
      else if (key === 'doubleSided') input.checked = !!this.selection!.material.data[6];
      else if (key === 'roughness' || key === 'metallic')
        input.value = String(this.selection!.material.data[key === 'roughness' ? 4 : 5]);
      else {
        const [kind, axis] = key.split('.') as ['position' | 'rotation' | 'scale', 'x' | 'y' | 'z'];
        input.value = String(this.selection![kind][axis]);
      }
    }
    const undo = this.buttons.get('undo')!,
      redo = this.buttons.get('redo')!;
    undo.disabled = !this.history.undoCount;
    redo.disabled = !this.history.redoCount;
    undo.title = this.history.nextUndo ? `Undo: ${this.history.nextUndo}` : 'Nothing to undo';
    redo.title = this.history.nextRedo ? `Redo: ${this.history.nextRedo}` : 'Nothing to redo';
    this.buttons.get('save')!.disabled = this.buttons.get('load')!.disabled = !engine || engine.disposed;
    // The two sections are text built only while open, so a closed panel costs nothing.
    if (engine && !engine.disposed) {
      if (this.details.get('resources')!.open) {
        const r = describeEngine(engine, this.meshes());
        this.outputs.get('resources')!.textContent =
          `${r.backend}  ${r.canvas.width} x ${r.canvas.height}\n` +
          `${r.meshes} meshes (${r.visibleMeshes} visible)\n${r.geometries} geometries, ${r.vertices} vertices\n` +
          `${r.materials} materials, ${r.triangles} triangles drawn\nPlugins: ${r.plugins.join(', ') || 'none'}`;
      }
      if (this.details.get('shader')!.open)
        this.outputs.get('shader')!.textContent =
          this.shader || (engine.backend === 'webgpu' ? 'Waiting for the first frame.' : 'WGSL shows on WebGPU only.');
    }
  }

  private toggle(mesh: Mesh): void {
    if (this.collapsed.has(mesh)) this.collapsed.delete(mesh);
    else this.collapsed.add(mesh);
    this.refresh();
    this.items.get(mesh)?.focus();
  }
  private keydown(event: KeyboardEvent): void {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]');
    if (!item || !this.engine) return;
    const mesh = this.engine.meshes.get(Number(item.dataset.entity))!;
    const visible = [...this.tree.querySelectorAll<HTMLElement>('[role=treeitem]')].filter(
      (row) => !row.closest('[hidden]'),
    );
    let target: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowDown':
        target = visible[Math.min(visible.length - 1, visible.indexOf(item) + 1)];
        break;
      case 'ArrowUp':
        target = visible[Math.max(0, visible.indexOf(item) - 1)];
        break;
      case 'Home':
        target = visible[0];
        break;
      case 'End':
        target = visible.at(-1);
        break;
      case 'ArrowRight':
        if (item.hasAttribute('aria-expanded')) {
          if (this.collapsed.has(mesh)) this.toggle(mesh);
          else target = item.querySelector<HTMLElement>('[role=group]>[role=treeitem]') ?? undefined;
        }
        break;
      case 'ArrowLeft':
        if (item.getAttribute('aria-expanded') === 'true') this.toggle(mesh);
        else target = item.parentElement?.closest<HTMLElement>('[role=treeitem]') ?? undefined;
        break;
      case 'Enter':
      case ' ':
        this.select(mesh);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target) {
      this.select(this.engine.meshes.get(Number(target.dataset.entity))!);
      this.items.get(this.selection!)?.focus();
    }
  }

  onDeviceRestored(engine: Engine): void {
    this.lines.onDeviceRestored(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    clearInterval(this.timer);
    this.stopPicking?.();
    this.stopPicking = undefined;
    this.history.clear();
    this.shader = '';
    this.lines.clear();
    this.lines.dispose();
    this.helpers.clear();
    this.lightLines = undefined;
    this.items.clear();
    this.collapsed.clear();
    this.selection = null;
    this.element.remove();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
