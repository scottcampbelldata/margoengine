/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  Geometry,
  PbrMaterial,
  type Engine,
  type Mesh,
  type Scene,
} from '@margoengine/core/extension';
import {
  boxGeometry,
  sphereGeometry,
  planeGeometry,
  cylinderGeometry,
  coneGeometry,
  capsuleGeometry,
  torusGeometry,
  circleGeometry,
  ringGeometry,
  torusKnotGeometry,
} from '@margoengine/geometry/primitives';
import { Clustered, type PointLight, type SpotLight } from '@margoengine/clustered';
import { DirectionalLights, type DirectionalLight } from '@margoengine/clustered/directional';
import { worldMatrix } from '@margoengine/scene';
import { fault } from '../../shared/errors.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { hiddenInTree } from '../../shared/visibility.js';
import type { Inspector } from './index.js';
import { editorDeleted, editorRetained } from './edit-state.js';

const primitives = {
  box: boxGeometry,
  sphere: sphereGeometry,
  plane: planeGeometry,
  cylinder: cylinderGeometry,
  cone: coneGeometry,
  capsule: capsuleGeometry,
  torus: torusGeometry,
  circle: circleGeometry,
  ring: ringGeometry,
  torusKnot: torusKnotGeometry,
};
/** Primitives built by the existing geometry package, with its default dimensions. */
export type EditorPrimitive = keyof typeof primitives;
/** Light kinds supported by the engine's existing lighting packages. */
export type EditorLightKind = 'point' | 'spot' | 'directional' | 'ambient';
/** Editable light values. Position and direction follow the anchor's full parent transform. */
export interface EditorLight {
  kind: EditorLightKind;
  color: [number, number, number];
  intensity: number;
  range: number;
  angle: number;
  penumbra: number;
}
/** Settings for an editor attached to an inspector's own scene. */
export interface SceneEditorOptions {
  /** Toolbar parent; default inspector shadow root. Null hides it. */
  parent?: HTMLElement | ShadowRoot | null;
  /** Existing lights, otherwise the scene's Clustered or a lazily attached one. WebGPU only. */
  lights?: Clustered;
  /** Existing directional lights, otherwise the scene's or a lazily attached one. */
  directional?: DirectionalLights;
  /** Delete and Ctrl/Cmd+D in the inspector tree. Default true. */
  keyboard?: boolean;
  signal?: AbortSignal;
}
type Saved = { mesh: Mesh; geometry: Geometry | null; visible: boolean };
let nextEditor = 0;

/** Undoable primitive/light creation, subtree deletion/duplication and tree drag reparenting. */
export class SceneEditor {
  readonly element: HTMLFieldSetElement;
  private readonly runtime: Engine;
  private readonly scene: Scene;
  private readonly pluginName = `inspector:edit:${++nextEditor}`;
  private readonly tree: HTMLElement;
  private readonly observer?: MutationObserver;
  private readonly lightData = new Map<Mesh, EditorLight>();
  private readonly outputs = new Set<object>();
  private lights?: Clustered;
  private directional?: DirectionalLights;
  private readonly ambient: number[];
  private readonly owned: string[] = [];
  private ambientActive = false;
  private dragging?: Mesh;
  private disposed = false;
  private readonly stopHistory: () => void;
  private readonly abort = () => this.dispose();

  static attach(engine: EngineKernel, inspector: Inspector, options: SceneEditorOptions = {}): SceneEditor {
    return new SceneEditor(engine, inspector, options);
  }
  constructor(
    readonly engine: EngineKernel,
    readonly inspector: Inspector,
    private readonly options: SceneEditorOptions = {},
  ) {
    options.signal?.throwIfAborted();
    this.runtime = engineRuntime(engine);
    const scene = this.runtime.sceneOf(inspector);
    if (!scene) throw fault('state', 'Attach the inspector to this engine before its scene editor');
    this.scene = scene;
    if ([...scene.plugins.keys()].some((name) => name.startsWith('inspector:edit:')))
      throw fault('attached', 'Only one scene editor may own a scene; reuse its existing editor', 'state');
    this.lights = options.lights ?? (scene.plugins.get('clustered') as Clustered | undefined);
    this.directional =
      options.directional ?? (scene.plugins.get('clustered:directional') as DirectionalLights | undefined);
    for (const plugin of [this.lights, this.directional])
      if (plugin && this.runtime.sceneOf(plugin) !== scene)
        throw fault('state', 'Editor lights must belong to the inspector scene');
    this.ambient = [...scene.lighting.ambient, scene.lighting.radiance[3]];
    const doc = inspector.element.ownerDocument;
    this.tree = inspector.root.querySelector('[role=tree]')!;
    this.element = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    legend.textContent = 'Scene editing';
    this.element.append(legend);
    const kinds = doc.createElement('select');
    kinds.setAttribute('aria-label', 'Create entity');
    for (const kind of [
      ...Object.keys(primitives),
      'point light',
      'spot light',
      'directional light',
      'ambient light',
    ]) {
      const option = doc.createElement('option');
      option.value = option.textContent = kind;
      kinds.append(option);
    }
    this.element.append(kinds);
    const status = doc.createElement('output');
    status.setAttribute('role', 'status');
    const report = (run: () => unknown) => {
      try {
        run();
        status.textContent = '';
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    for (const [label, action] of [
      [
        'Create',
        () =>
          kinds.value.endsWith(' light')
            ? this.createLight(kinds.value.split(' ')[0] as EditorLightKind)
            : this.createPrimitive(kinds.value as EditorPrimitive),
      ],
      ['Duplicate', () => this.duplicate()],
      ['Delete', () => this.delete()],
      ['Move to root', () => this.reparent(this.selected(), null)],
    ] as const) {
      const button = doc.createElement('button');
      button.textContent = label;
      button.addEventListener('click', () => report(action));
      this.element.append(button);
    }
    this.element.append(status);
    (options.parent === undefined ? inspector.root : options.parent)?.append(this.element);
    this.tree.addEventListener('dragstart', this.dragStart);
    this.tree.addEventListener('dragover', this.dragOver);
    this.tree.addEventListener('drop', this.drop);
    this.tree.addEventListener('dragend', this.dragEnd);
    if (options.keyboard !== false) this.tree.addEventListener('keydown', this.keyDown);
    this.stopHistory = inspector.history.onChange(() => this.refresh());
    const Observer = doc.defaultView?.MutationObserver;
    if (Observer) {
      this.observer = new Observer(() => this.refresh());
      this.observer.observe(this.tree, { childList: true, subtree: true });
      this.observer.observe(inspector.element.parentNode!, { childList: true });
    }
    scene.use({
      name: this.pluginName,
      setup() {},
      onPreUpdate: () => this.syncLights(),
      dispose: () => this.dispose(),
    });
    options.signal?.addEventListener('abort', this.abort, { once: true });
    this.refresh();
  }
  private alive(): void {
    if (this.disposed || this.runtime.disposed)
      throw fault('disposed', 'Scene editor is disposed; attach a new editor');
  }
  private selected(): Mesh {
    const mesh = this.inspector.selected;
    if (!mesh) throw fault('state', 'Select an entity in the tree first');
    return this.check(mesh);
  }
  private check(handle: MeshHandle): Mesh {
    this.alive();
    const mesh = meshRuntime(handle);
    mesh.check();
    if (mesh.scene !== this.scene || editorDeleted.has(mesh))
      throw fault('state', 'Choose a live entity in the inspector scene');
    return mesh;
  }
  private subtree(root: Mesh): Mesh[] {
    const out: Mesh[] = [];
    const visit = (mesh: Mesh) => {
      if (meshTriangles(mesh)?.kind === 'pbr')
        throw fault(
          'unsupported',
          'Package-owned models need their package editor; edit core primitive hierarchies here',
        );
      out.push(mesh);
      for (const id of mesh.kids ?? []) {
        const child = this.runtime.meshes.get(id)!;
        if (!editorDeleted.has(child)) visit(child);
      }
    };
    visit(root);
    return out;
  }
  private presence(nodes: Mesh[], label: string, present: boolean): void {
    let saved: Saved[] = [];
    const hide = () => {
      saved = nodes.map((mesh) => ({ mesh, geometry: mesh.geometry, visible: mesh.visible }));
      for (const { mesh } of saved) {
        mesh.setGeometry(null);
        mesh.visible = false;
        editorDeleted.add(mesh);
      }
      if (this.inspector.selected && nodes.includes(meshRuntime(this.inspector.selected))) this.inspector.select(null);
      this.syncLights();
      this.inspector.refresh();
    };
    const show = () => {
      const restored: Mesh[] = [];
      try {
        for (const { mesh, geometry } of saved) {
          mesh.setGeometry(geometry);
          restored.push(mesh);
        }
      } catch (error) {
        for (const mesh of restored) mesh.setGeometry(null);
        throw error;
      }
      for (const { mesh, visible } of saved) {
        mesh.visible = visible;
        editorDeleted.delete(mesh);
      }
      this.syncLights();
      this.inspector.select(nodes[0]);
    };
    if (!present) hide();
    for (const mesh of nodes) editorRetained.set(mesh, (editorRetained.get(mesh) ?? 0) + 1);
    this.inspector.history.record({
      label,
      undo: present ? hide : show,
      redo: present ? show : hide,
      discard: () => {
        for (const mesh of [...nodes].reverse()) {
          const count = editorRetained.get(mesh)! - 1;
          if (count) editorRetained.set(mesh, count);
          else {
            editorRetained.delete(mesh);
            if (editorDeleted.has(mesh)) {
              editorDeleted.delete(mesh);
              this.lightData.delete(mesh);
              mesh.dispose();
            }
          }
        }
      },
    });
    if (present) this.inspector.select(nodes[0]);
  }
  /** Creates one primitive at the origin, parent-relative, and selects it. Default box, root parent. */
  createPrimitive(kind: EditorPrimitive = 'box', parent: MeshHandle | null = null): MeshHandle {
    this.alive();
    if (!Object.hasOwn(primitives, kind)) throw new TypeError('Unknown primitive; choose a documented primitive kind');
    const p = parent ? this.check(parent) : null,
      data = primitives[kind](),
      geometry = new Geometry(data.positions, data.normals, data.indices),
      mesh = this.scene.createMesh(p);
    try {
      mesh.setGeometry(geometry);
    } catch (error) {
      mesh.dispose();
      throw error;
    }
    mesh.name = kind;
    this.presence([mesh], `Create ${kind}`, true);
    return mesh;
  }
  /** Creates a selectable transform anchor and a real light. Default point, white, intensity 1, range 10, angle PI/4, penumbra 0. */
  createLight(
    kind: EditorLightKind = 'point',
    values: Partial<Omit<EditorLight, 'kind'>> = {},
    parent: MeshHandle | null = null,
  ): MeshHandle {
    this.alive();
    if (!['point', 'spot', 'directional', 'ambient'].includes(kind)) throw new TypeError('Unknown light kind; use point, spot, directional or ambient');
    const data = this.validateLight({
      kind,
      color: [1, 1, 1],
      intensity: 1,
      range: 10,
      angle: Math.PI / 4,
      penumbra: 0,
      ...values,
    });
    const p = parent ? this.check(parent) : null;
    if (kind !== 'ambient') this.ensureLights(kind === 'directional');
    const mesh = this.scene.createMesh(p);
    mesh.name = `${kind} light`;
    this.lightData.set(mesh, data);
    try {
      this.syncLights();
    } catch (error) {
      this.lightData.delete(mesh);
      mesh.dispose();
      this.syncLights();
      throw error;
    }
    this.presence([mesh], `Create ${mesh.name}`, true);
    return mesh;
  }
  /** A copy of an editor light's local settings, or undefined for a primitive. */
  light(handle: MeshHandle): EditorLight | undefined {
    const value = this.lightData.get(this.check(handle));
    return value ? { ...value, color: [...value.color] } : undefined;
  }
  /** Updates light settings as one undoable operation. Transform edits use inspector properties or its gizmo. */
  setLight(handle: MeshHandle, values: Partial<Omit<EditorLight, 'kind'>>): void {
    const mesh = this.check(handle),
      before = this.light(mesh);
    if (!before) throw fault('state', 'Choose a light created by this editor');
    const after = this.validateLight({ ...before, ...values });
    const apply = (data: EditorLight) => {
      const previous = this.lightData.get(mesh)!;
      this.lightData.set(mesh, data);
      try {
        this.syncLights();
      } catch (error) {
        this.lightData.set(mesh, previous);
        this.syncLights();
        throw error;
      }
    };
    apply(after);
    this.inspector.history.record({ label: `Edit ${mesh.name}`, undo: () => apply(before), redo: () => apply(after) });
  }
  private validateLight(value: EditorLight): EditorLight {
    if (
      !Array.isArray(value.color) ||
      value.color.length !== 3 ||
      value.color.some((v) => !Number.isFinite(v) || v < 0) ||
      ![value.intensity, value.range, value.angle, value.penumbra].every(Number.isFinite) ||
      value.intensity < 0 ||
      value.range < 0 ||
      value.angle <= 0 ||
      value.angle > Math.PI / 2 ||
      value.penumbra < 0 ||
      value.penumbra > 1
    )
      throw new RangeError('Light needs nonnegative finite RGB, intensity/range, angle (0, PI/2] and penumbra [0,1]');
    return { ...value, color: [...value.color] };
  }
  private ensureLights(directional: boolean): void {
    if (this.engine.backend !== 'webgpu')
      throw fault(
        'unsupported',
        'Local and additional directional lights require WebGPU or the WebGL2 compatibility device; preview supports ambient editing',
      );
    if (!this.lights) {
      this.lights = new Clustered();
      this.scene.use(this.lights);
      this.owned.push(this.lights.name);
    }
    if (directional && !this.directional) {
      this.directional = new DirectionalLights({ lights: this.lights });
      this.scene.use(this.directional);
      this.owned.push(this.directional.name);
    }
  }
  private syncLights(): void {
    if (this.runtime.disposed) return;
    const locals: (PointLight | SpotLight)[] = [],
      directions: DirectionalLight[] = [],
      ambient = this.ambient.slice(0, 3).map((v) => v * this.ambient[3]);
    let hasAmbient = false;
    for (const [mesh, value] of this.lightData) {
      if (
        editorDeleted.has(mesh) ||
        this.runtime.meshes.get(mesh.id) !== mesh ||
        hiddenInTree(this.runtime.store, mesh.id)
      )
        continue;
      const m = worldMatrix(mesh),
        position = [m[12], m[13], m[14]] as [number, number, number],
        direction = [-m[8], -m[9], -m[10]] as [number, number, number],
        color = [...value.color] as [number, number, number];
      if (value.kind === 'ambient') {
        hasAmbient = true;
        for (let i = 0; i < 3; i++) ambient[i] += color[i] * value.intensity;
      } else if (value.kind === 'directional') directions.push({ direction, color, intensity: value.intensity });
      else
        locals.push({
          position,
          color,
          intensity: value.intensity,
          range: value.range,
          ...(value.kind === 'spot' ? { direction, angle: value.angle, penumbra: value.penumbra } : {}),
        });
    }
    const localBase = this.lights?.list.filter((light) => !this.outputs.has(light)) ?? [],
      directionBase = this.directional?.list.filter((light) => !this.outputs.has(light)) ?? [];
    this.lights?.setLights([...localBase, ...locals]);
    this.directional?.setLights([...directionBase, ...directions]);
    this.outputs.clear();
    for (const value of [...locals, ...directions]) this.outputs.add(value);
    if (hasAmbient || this.ambientActive) {
      this.scene.lighting.ambient.set(hasAmbient ? ambient : this.ambient.slice(0, 3));
      this.scene.lighting.radiance[3] = hasAmbient ? 1 : this.ambient[3];
    }
    this.ambientActive = hasAmbient;
  }
  /** Deletes the selected subtree (default) as one step. Original mesh handles survive until history eviction. */
  delete(handle: MeshHandle = this.selected()): void {
    const mesh = this.check(handle);
    this.presence(this.subtree(mesh), `Delete ${mesh.name || 'entity'}`, false);
  }
  /** Deep-copies a subtree, shares immutable geometries and copies each distinct material once. */
  duplicate(handle: MeshHandle = this.selected()): MeshHandle {
    const source = this.subtree(this.check(handle)),
      copies = new Map<Mesh, Mesh>(),
      materials = new Map<PbrMaterial, PbrMaterial>();
    try {
      for (const mesh of source) {
        const oldParent = this.runtime.meshes.get(this.runtime.store.parents[mesh.id]) ?? null,
          copy = this.scene.createMesh(oldParent ? (copies.get(oldParent) ?? oldParent) : null);
        copies.set(mesh, copy);
        copy.name = mesh === source[0] ? `${mesh.name || 'Entity'} copy` : mesh.name;
        copy
          .setGeometry(mesh.geometry)
          .setPosition([mesh.position.x, mesh.position.y, mesh.position.z])
          .setScale([mesh.scale.x, mesh.scale.y, mesh.scale.z]);
        copy.setQuaternion(['qx', 'qy', 'qz', 'qw'].map((key) => this.runtime.store.transforms[key as 'qx'][mesh.id]));
        copy.visible = mesh.visible;
        copy.receiveShadow = mesh.receiveShadow;
        let material = materials.get(mesh.material);
        if (!material) {
          material = new PbrMaterial();
          material.data.set(mesh.material.data);
          materials.set(mesh.material, material);
        }
        copy.setMaterial(material);
        const light = this.lightData.get(mesh);
        if (light) this.lightData.set(copy, { ...light, color: [...light.color] });
      }
      this.syncLights();
    } catch (error) {
      for (const mesh of [...copies.values()].reverse()) {
        this.lightData.delete(mesh);
        mesh.dispose();
      }
      this.syncLights();
      throw error;
    }
    const nodes = [...copies.values()];
    this.presence(nodes, `Duplicate ${source[0].name || 'entity'}`, true);
    return nodes[0];
  }
  /** Reparents with local transform preserved, as one undo step. Null moves to the root. Cycles reject before editing. */
  reparent(handle: MeshHandle, parent: MeshHandle | null): void {
    const mesh = this.check(handle),
      next = parent ? this.check(parent) : null,
      previous = this.runtime.meshes.get(this.runtime.store.parents[mesh.id]) ?? null;
    if (next === previous) return;
    // Check the whole moved subtree against the engine's depth limit before writing.
    let depth = 0;
    for (let p = next; p; p = this.runtime.meshes.get(this.runtime.store.parents[p.id]) ?? null) {
      if (p === mesh) throw fault('state', 'Cannot parent an entity below itself; choose a different parent');
      depth++;
    }
    const nodes = this.subtree(mesh);
    for (const child of nodes) {
      let distance = 0;
      for (let p = child; p !== mesh; p = this.runtime.meshes.get(this.runtime.store.parents[p.id])!) distance++;
      if (depth + distance >= 64) throw new RangeError('Parent depth must remain below 64; choose a shallower parent');
    }
    const apply = (value: Mesh | null) => {
      mesh.setParent(value);
      this.syncLights();
      this.inspector.select(mesh);
    };
    apply(next);
    this.inspector.history.record({
      label: `Reparent ${mesh.name || 'entity'}`,
      undo: () => apply(previous),
      redo: () => apply(next),
    });
  }
  private item(event: Event): Mesh | undefined {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-entity]');
    return row ? this.scene.meshes.get(Number(row.dataset.entity)) : undefined;
  }
  private readonly dragStart = (event: DragEvent): void => {
    this.dragging = this.item(event);
    if (!this.dragging) return;
    event.dataTransfer?.setData('text/plain', String(this.dragging.id));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    event.stopPropagation();
  };
  private readonly dragOver = (event: DragEvent): void => {
    if (this.dragging) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }
  };
  private readonly dragEnd = (): void => {
    this.dragging = undefined;
  };
  private readonly drop = (event: DragEvent): void => {
    const mesh = this.dragging;
    this.dragging = undefined;
    if (!mesh) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      this.reparent(mesh, this.item(event) ?? null);
    } catch (error) {
      this.element.querySelector('output')!.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Delete' && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd')) return;
    event.preventDefault();
    try {
      if (event.key === 'Delete') this.delete();
      else this.duplicate();
    } catch (error) {
      this.element.querySelector('output')!.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  /** Marks regenerated tree rows draggable. Called automatically on tree changes. */
  refresh(): void {
    if (this.disposed) return;
    if (!this.inspector.element.isConnected) {
      this.dispose();
      return;
    }
    for (const row of this.tree.querySelectorAll<HTMLElement>('[data-entity]')) row.draggable = true;
  }
  /** Removes editor UI/input and its owned lights. Scene meshes and shared undo history remain usable. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.stopHistory?.();
    this.options.signal?.removeEventListener('abort', this.abort);
    this.tree.removeEventListener('dragstart', this.dragStart);
    this.tree.removeEventListener('dragover', this.dragOver);
    this.tree.removeEventListener('drop', this.drop);
    this.tree.removeEventListener('dragend', this.dragEnd);
    this.tree.removeEventListener('keydown', this.keyDown);
    for (const row of this.tree.querySelectorAll<HTMLElement>('[data-entity]')) row.draggable = false;
    this.lightData.clear();
    this.syncLights();
    for (const name of this.owned.reverse()) this.scene.removePlugin(name);
    this.element.remove();
    this.scene.removePlugin(this.pluginName);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
