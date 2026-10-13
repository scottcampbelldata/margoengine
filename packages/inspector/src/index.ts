import type {EngineKernel, Mesh as MeshHandle} from '@margoengine/core';
import {engineRuntime, meshRuntime, type Engine, type EnginePlugin, type FrameGraph, type Geometry, type Mesh} from '@margoengine/core/extension';
import {Lines, Line, BoxHelper, VertexNormalsHelper} from '@margoengine/lines';

export interface InspectorOptions {
  parent?: HTMLElement;
  /** Mutable options of an attached PostProcessing/Tonemap effect. */
  effects?: {exposure?: number; bloom?: number};
}
type Mode = 'wireframe' | 'normals' | 'bounds';
interface DebugLines {geometry: Geometry; wireframe?: Line; normals?: Line; bounds?: Line}
const wirePositions = new WeakMap<Geometry, Float32Array>();

function wireframe(mesh: Mesh): Line {
  const geometry = mesh.geometry!;
  let positions = wirePositions.get(geometry);
  if (!positions) {
    const indices = geometry.indices, vertices = geometry.vertices, count = vertices.length / 6, seen = new Set<number>(), data: number[] = [];
    for (let i = 0; i < indices.length; i += 3) for (let edge = 0; edge < 3; edge++) {
      const a = indices[i + edge], b = indices[i + (edge + 1) % 3], key = Math.min(a, b) * count + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key); data.push(vertices[a * 6], vertices[a * 6 + 1], vertices[a * 6 + 2], vertices[b * 6], vertices[b * 6 + 1], vertices[b * 6 + 2]);
    }
    positions = new Float32Array(data); wirePositions.set(geometry, positions);
  }
  return new Line({mesh, positions, mode: 'segments', color: '#72e8cc', onTop: true, cap: 'butt', join: 'miter'});
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
`;

export class Inspector implements EnginePlugin {
  readonly name = 'inspector';
  readonly element: HTMLDivElement;
  readonly root: ShadowRoot;
  readonly debug = {wireframe: false, normals: false, bounds: false};
  private engine?: Engine;
  private selection: Mesh | null = null;
  private readonly lines = new Lines({name: 'inspector:lines'});
  private readonly helpers = new Map<Mesh, DebugLines>();
  private readonly collapsed = new Set<Mesh>();
  private readonly items = new Map<Mesh, HTMLElement>();
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly tree: HTMLDivElement;
  private readonly effects?: InspectorOptions['effects'];
  private signature = '';
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor({parent = document.body, effects}: InspectorOptions = {}) {
    this.effects = effects;
    const doc = parent.ownerDocument;
    this.element = doc.createElement('div'); this.element.dataset.margoInspector = '';
    this.root = this.element.attachShadow({mode: 'open'});
    const style = doc.createElement('style'); style.textContent = css;
    const panel = doc.createElement('section'), title = doc.createElement('h2'); title.textContent = 'Inspector';
    panel.append(title); this.root.append(style, panel);
    const modes = doc.createElement('fieldset');
    for (const [key, text] of [['wireframe', 'Wireframe'], ['normals', 'Vertex normals'], ['bounds', 'AABB bounds']] as const) {
      const input = this.input(modes, key, text, 'checkbox');
      input.addEventListener('change', () => this.setDebug(key, input.checked));
    }
    panel.append(modes);
    this.tree = doc.createElement('div'); this.tree.setAttribute('role', 'tree'); this.tree.setAttribute('aria-label', 'Scene entities'); panel.append(this.tree);
    this.tree.addEventListener('keydown', event => this.keydown(event));
    const properties = doc.createElement('fieldset'), legend = doc.createElement('legend'); legend.textContent = 'Entity'; properties.append(legend);
    const name = this.input(properties, 'name', 'Name', 'text');
    name.addEventListener('change', () => {if (this.liveSelection()) {this.selection!.name = name.value; this.refresh();}});
    const visible = this.input(properties, 'visible', 'Visible', 'checkbox');
    visible.addEventListener('change', () => {if (this.liveSelection()) this.selection!.visible = visible.checked;});
    for (const kind of ['position', 'rotation', 'scale'] as const) {
      const label = doc.createElement('div'); label.textContent = kind[0].toUpperCase() + kind.slice(1); properties.append(label);
      const axes = doc.createElement('div'); axes.className = 'axes'; properties.append(axes);
      for (const axis of ['x', 'y', 'z'] as const) {
        const input = this.input(axes, `${kind}.${axis}`, axis.toUpperCase(), 'number'); input.step = '0.01';
        input.setAttribute('aria-label', `${kind} ${axis}`);
        input.addEventListener('change', () => this.edit(input, () => {if (this.liveSelection()) this.selection![kind][axis] = input.valueAsNumber;}));
      }
    }
    for (const [key, label, slot, min] of [['roughness', 'Roughness', 4, 0.045], ['metallic', 'Metallic', 5, 0]] as const) {
      const input = this.input(properties, key, label, 'range'); input.min = String(min); input.max = '1'; input.step = '0.005';
      input.addEventListener('input', () => this.edit(input, () => {
        const value = input.valueAsNumber;
        if (!Number.isFinite(value) || value < min || value > 1) throw new RangeError('Invalid material value');
        if (this.liveSelection()) this.selection!.material.data[slot] = value;
      }));
    }
    panel.append(properties);
    const grading = doc.createElement('fieldset'), gradeTitle = doc.createElement('legend'); gradeTitle.textContent = 'Effects'; grading.append(gradeTitle);
    for (const [key, label, min, max] of [['exposure', 'Exposure', -10, 10], ['bloom', 'Bloom', 0, 4]] as const) {
      const input = this.input(grading, key, label, 'range'); input.min = String(min); input.max = String(max); input.step = '0.05';
      input.addEventListener('input', () => this.edit(input, () => {
        const value = input.valueAsNumber;
        if (!Number.isFinite(value) || value < min || value > max) throw new RangeError('Invalid effect value');
        if (this.effects) this.effects[key] = value;
      }));
    }
    panel.append(grading); parent.append(this.element); this.refresh();
    this.timer = setInterval(() => this.refresh(), 250);
  }

  static attach(engine: EngineKernel, options: InspectorOptions = {}): Inspector {
    const inspector = new Inspector(options); try {engineRuntime(engine).use(inspector); return inspector;} catch (error) {inspector.dispose(); throw error;}
  }
  get selected(): MeshHandle | null {return this.selection;}

  select(handle: MeshHandle | null): void {
    if (this.disposed || !this.engine) throw new Error('Inspector is not attached');
    const mesh = handle ? meshRuntime(handle) : null;
    if (mesh) {mesh.check(); if (mesh.engine !== this.engine) throw new TypeError('Mesh belongs to another engine');}
    this.selection = mesh;
    if (mesh) for (let id = this.engine.store.parents[mesh.id]; id !== -1; id = this.engine.store.parents[id]) this.collapsed.delete(this.engine.meshes.get(id)!);
    this.signature = ''; this.refresh();
  }

  setDebug(mode: Mode, enabled: boolean): void {
    if (this.disposed) throw new Error('Inspector is disposed');
    if (!Object.hasOwn(this.debug, mode) || typeof enabled !== 'boolean') throw new TypeError('Invalid debug mode');
    if (enabled && this.engine?.backend !== 'webgpu') throw new Error('Debug rendering requires WebGPU');
    this.debug[mode] = enabled; this.inputs.get(mode)!.checked = enabled;
  }

  setup(engine: Engine): void {
    if (this.disposed || this.engine) throw new Error('Inspector is disposed or attached');
    this.engine = engine;
    if (engine.backend === 'webgpu') this.lines.setup(engine);
    this.refresh();
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({name: 'inspector:sync', order: 19, execute: () => this.syncDebug()}); this.lines.registerPasses(graph);
  }

  private syncDebug(): void {
    const engine = this.engine!;
    if (!this.helpers.size && !this.debug.wireframe && !this.debug.normals && !this.debug.bounds) return;
    for (const [mesh, helpers] of this.helpers) if (engine.meshes.get(mesh.id) !== mesh || mesh.geometry !== helpers.geometry) {
      helpers.wireframe?.dispose(); helpers.normals?.dispose(); helpers.bounds?.dispose(); this.helpers.delete(mesh);
    }
    if (engine.backend !== 'webgpu') return;
    for (const mesh of engine.meshes.values()) {
      if (!mesh.geometry) continue;
      let helpers = this.helpers.get(mesh);
      if (!helpers && (this.debug.wireframe || this.debug.normals || this.debug.bounds)) {helpers = {geometry: mesh.geometry}; this.helpers.set(mesh, helpers);}
      if (!helpers) continue;
      for (const mode of ['wireframe', 'normals', 'bounds'] as const) {
        if (this.debug[mode] && !helpers[mode]) helpers[mode] = this.lines.add(mode === 'wireframe' ? wireframe(mesh) : mode === 'normals' ?
          new VertexNormalsHelper(mesh, {size: mesh.geometry.bounds[3] * 0.15, color: '#ed6b86', onTop: true}) : new BoxHelper(mesh, {color: '#e4ba31', onTop: true}));
        if (helpers[mode]) helpers[mode]!.visible = this.debug[mode] && !!engine.store.visible[mesh.id];
      }
    }
  }

  private input(parent: HTMLElement, key: string, text: string, type: string): HTMLInputElement {
    const doc = this.element.ownerDocument, label = doc.createElement('label'), span = doc.createElement('span'), input = doc.createElement('input');
    span.textContent = text; input.type = type; input.dataset.property = key; label.append(span, input); parent.append(label); this.inputs.set(key, input); return input;
  }
  private liveSelection(): boolean {return !!this.selection && this.engine?.meshes.get(this.selection.id) === this.selection;}
  private edit(input: HTMLInputElement, action: () => void): void {
    try {action(); input.setCustomValidity('');} catch (error) {input.setCustomValidity(String(error));}
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    const engine = this.engine;
    if (this.selection && !this.liveSelection()) this.selection = null;
    let signature = '', replaced = false;
    if (engine && !engine.disposed) for (const mesh of engine.meshes.values()) {
      signature += JSON.stringify([mesh.id, mesh.name, engine.store.parents[mesh.id], mesh.visible, mesh === this.selection, this.collapsed.has(mesh)]);
      if (!this.items.has(mesh)) replaced = true;
    }
    if (signature !== this.signature || replaced) {
      const focused = this.tree.contains(this.root.activeElement);
      this.signature = signature; this.tree.replaceChildren(); this.items.clear();
      for (const mesh of [...this.collapsed]) if (engine?.meshes.get(mesh.id) !== mesh) this.collapsed.delete(mesh);
      if (engine) {
        const groups = new Map<number, HTMLElement>(), doc = this.element.ownerDocument;
        for (const mesh of engine.meshes.values()) {
          const item = doc.createElement('div'), row = doc.createElement('div'), name = doc.createElement('span'), group = doc.createElement('div');
          item.setAttribute('role', 'treeitem'); item.setAttribute('aria-selected', String(mesh === this.selection)); item.tabIndex = mesh === this.selection ? 0 : -1;
          item.dataset.entity = String(mesh.id); row.className = 'row'; name.className = 'name'; name.textContent = mesh.name || `Entity ${mesh.id}`;
          if (!mesh.visible) name.classList.add('muted');
          row.addEventListener('click', () => {this.select(mesh); this.items.get(mesh)?.focus();});
          group.setAttribute('role', 'group'); group.hidden = this.collapsed.has(mesh);
          row.append(name); item.append(row, group); groups.set(mesh.id, group); this.items.set(mesh, item);
        }
        for (const [mesh, item] of this.items) {
          const parent = engine.store.parents[mesh.id]; (groups.get(parent) ?? this.tree).append(item);
        }
        for (const [mesh, item] of this.items) {
          const group = groups.get(mesh.id)!;
          if (group.childElementCount) {
            const button = doc.createElement('button'); button.type = 'button'; button.tabIndex = -1; button.textContent = this.collapsed.has(mesh) ? '+' : '-';
            button.setAttribute('aria-label', `Toggle ${mesh.name || 'entity'} children`); item.setAttribute('aria-expanded', String(!group.hidden));
            button.addEventListener('click', event => {event.stopPropagation(); this.toggle(mesh);}); item.firstElementChild!.prepend(button);
          }
        }
        const first = this.tree.querySelector<HTMLElement>('[role=treeitem]'); if (first && !this.selection) first.tabIndex = 0;
      }
      if (focused) (this.selection ? this.items.get(this.selection) : this.tree.querySelector<HTMLElement>('[role=treeitem]'))?.focus();
    }
    for (const [key, input] of this.inputs) {
      if (key in this.debug) {input.disabled = engine?.backend !== 'webgpu'; continue;}
      const effect = key === 'exposure' || key === 'bloom';
      input.disabled = effect ? !this.effects || !(key in this.effects) : !this.liveSelection();
      if (this.root.activeElement === input || input.disabled) continue;
      if (effect) input.value = String(this.effects![key as 'exposure' | 'bloom'] ?? 0);
      else if (key === 'name') input.value = this.selection!.name;
      else if (key === 'visible') input.checked = this.selection!.visible;
      else if (key === 'roughness' || key === 'metallic') input.value = String(this.selection!.material.data[key === 'roughness' ? 4 : 5]);
      else {const [kind, axis] = key.split('.') as ['position' | 'rotation' | 'scale', 'x' | 'y' | 'z']; input.value = String(this.selection![kind][axis]);}
    }
  }

  private toggle(mesh: Mesh): void {
    if (this.collapsed.has(mesh)) this.collapsed.delete(mesh); else this.collapsed.add(mesh);
    this.refresh(); this.items.get(mesh)?.focus();
  }
  private keydown(event: KeyboardEvent): void {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]');
    if (!item || !this.engine) return;
    const mesh = this.engine.meshes.get(Number(item.dataset.entity))!;
    const visible = [...this.tree.querySelectorAll<HTMLElement>('[role=treeitem]')].filter(row => !row.closest('[hidden]'));
    let target: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowDown': target = visible[Math.min(visible.length - 1, visible.indexOf(item) + 1)]; break;
      case 'ArrowUp': target = visible[Math.max(0, visible.indexOf(item) - 1)]; break;
      case 'Home': target = visible[0]; break;
      case 'End': target = visible.at(-1); break;
      case 'ArrowRight': if (item.hasAttribute('aria-expanded')) {if (this.collapsed.has(mesh)) this.toggle(mesh); else target = item.querySelector<HTMLElement>('[role=group]>[role=treeitem]') ?? undefined;} break;
      case 'ArrowLeft': if (item.getAttribute('aria-expanded') === 'true') this.toggle(mesh); else target = item.parentElement?.closest<HTMLElement>('[role=treeitem]') ?? undefined; break;
      case 'Enter': case ' ': this.select(mesh); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
    if (target) {this.select(this.engine.meshes.get(Number(target.dataset.entity))!); this.items.get(this.selection!)?.focus();}
  }

  onDeviceRestored(engine: Engine): void {this.lines.onDeviceRestored(engine);}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.engine?.removePlugin(this.name); this.engine = undefined;
    clearInterval(this.timer); this.lines.clear(); this.lines.dispose(); this.helpers.clear(); this.items.clear(); this.collapsed.clear(); this.selection = null; this.element.remove();
  }
}
