/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type Mesh } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { hexOf, linearOf } from './color.js';
import { EditHistory } from './history.js';

/** What an editable value is: a number, a switch, a linear RGB colour or an xyz vector. */
export type PropertyKind = 'number' | 'boolean' | 'color' | 'vector';
/** A property value: a number, a switch, or three numbers (a linear RGB colour or a vector). */
export type PropertyValue = number | boolean | readonly number[];

/** One editable value of a package object. `get` reads it live; `set` writes it (no range check: use `editProperty`). */
export interface PackageProperty {
  key: string;
  kind: PropertyKind;
  /** Lowest and highest value a number (or every vector component) may take. */
  min?: number;
  max?: number;
  get(): PropertyValue;
  set(value: PropertyValue): void;
  /** False while an optional field is unset and `get` reads its default; an undo back to that state unsets it again. */
  isSet?(): boolean;
}

/** An object of another package found on the engine (by shape: no package is imported), with its editable values. */
export interface PackageObject {
  /** Stable while the object lives, such as `light:clustered:0` or `effect:bloom`. */
  id: string;
  group: 'light' | 'material' | 'shadows' | 'effect' | 'object';
  label: string;
  target: object;
  properties: PackageProperty[];
  /** Why the values are shown but cannot be edited, when they cannot. */
  readOnly?: string;
}

type Range = readonly [number, number];
const anyNumber: Range = [-Infinity, Infinity],
  positive: Range = [0, Infinity],
  unit: Range = [0, 1],
  cone: Range = [0, Math.PI / 2];
/** Ranges of light fields (`@margoengine/clustered` PointLight, SpotLight, DirectionalLight, AreaLight). */
const lightRanges: Record<string, Range> = {
  intensity: positive,
  range: positive,
  decay: positive,
  outerAngle: cone,
  innerAngle: cone,
  angle: cone,
  penumbra: unit,
  width: positive,
  height: positive,
};
/** Options with documented defaults, per plugin name: shown even while unset. [default, min, max]. */
const optionTables: Record<string, Record<string, readonly [number, number, number]>> = {
  bloom: { strength: [0.8, 0, 4], threshold: [1, 0, 100], exposure: [0, -10, 10], radius: [0.5, 0, 1] },
  shadows: {
    distance: [500, 0, Infinity],
    lambda: [0.5, 0, 1],
    lightSize: [0.02, 0, Infinity],
    bias: [0.0005, 0, Infinity],
    normalBias: [0.02, 0, Infinity],
    casterMargin: [100, 0, Infinity],
  },
};
const isVec3 = (v: unknown): v is number[] | Float32Array =>
  (Array.isArray(v) || v instanceof Float32Array) && v.length === 3 && Array.from(v).every(Number.isFinite);
const kindOf = (key: string, value: unknown): PropertyKind | null =>
  typeof value === 'boolean'
    ? 'boolean'
    : typeof value === 'number' && Number.isFinite(value)
      ? 'number'
      : isVec3(value)
        ? /colou?r/i.test(key)
          ? 'color'
          : 'vector'
        : null;

/** A property on `target[key]`; `fallback` is what an unset key reads as, and an undo back to unset deletes the key. */
function field(
  target: Record<string, unknown>,
  key: string,
  kind: PropertyKind,
  range: Range = anyNumber,
  fallback?: PropertyValue,
): PackageProperty {
  return {
    key,
    kind,
    min: range[0],
    max: range[1],
    isSet: () => target[key] !== undefined,
    get: () => {
      const v = target[key];
      return v === undefined ? fallback! : isVec3(v) ? Array.from(v) : (v as PropertyValue);
    },
    set: (value) => {
      const v = target[key];
      if (value === undefined) delete target[key];
      else if (isVec3(v) && Array.isArray(value)) for (let i = 0; i < 3; i++) v[i] = value[i];
      else target[key] = Array.isArray(value) ? [...value] : value;
    },
  };
}
/** `data[index .. index + size]` of a packed array, as a number (size 1) or a vector. */
function slot(
  data: number[] | Float32Array,
  index: number,
  key: string,
  kind: PropertyKind,
  range = anyNumber,
): PackageProperty {
  const size = kind === 'number' || kind === 'boolean' ? 1 : 3;
  return {
    key,
    kind,
    min: range[0],
    max: range[1],
    get: () =>
      kind === 'boolean' ? data[index] >= 0.5 : size === 1 ? data[index] : Array.from(data.slice(index, index + 3)),
    set: (value) => {
      if (typeof value === 'boolean') data[index] = +value;
      else if (typeof value === 'number') data[index] = value;
      else for (let i = 0; i < 3; i++) data[index + i] = value[i];
    },
  };
}
/**
 * The plain numbers, switches and 3-vectors of an object: its own writable fields, and the accessors with a setter of
 * its class (a `@margoengine/materials` Material's `roughness`, an effect's `enabled`). Keys starting with `_` and
 * `name` are left out.
 */
export function describeObject(target: object, ranges: Record<string, Range> = {}, own = true): PackageProperty[] {
  const out: PackageProperty[] = [],
    seen = new Set<string>(),
    record = target as Record<string, unknown>;
  const consider = (key: string) => {
    if (seen.has(key) || key.startsWith('_') || key === 'name') return;
    seen.add(key);
    let value: unknown;
    try {
      value = record[key];
    } catch {
      return; // an accessor that throws in this state (before attach, say) is not a value to edit
    }
    const kind = kindOf(key, value);
    if (kind) out.push(field(record, key, kind, ranges[key]));
  };
  if (own)
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(target)))
      if (d.enumerable && (d.writable || d.set)) consider(key);
  for (
    let proto = Object.getPrototypeOf(target);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) if (d.get && d.set) consider(key);
  return out;
}

function lightObject(id: string, label: string, light: Record<string, unknown>): PackageObject {
  const properties = describeObject(light, lightRanges);
  if (!('color' in light)) properties.unshift(field(light, 'color', 'color', anyNumber, [1, 1, 1]));
  if (!('intensity' in light)) properties.splice(1, 0, field(light, 'intensity', 'number', positive, 1));
  return { id, group: 'light', label, target: light, properties };
}
function sunObject(engine: Engine): PackageObject {
  const { direction, radiance, ambient } = engine.lighting;
  return {
    id: 'light:sun',
    group: 'light',
    label: 'Sun and ambient (core)',
    target: engine.lighting,
    properties: [
      slot(direction, 0, 'direction', 'vector'),
      slot(direction, 3, 'intensity', 'number', positive),
      slot(radiance, 0, 'color', 'color'),
      slot(radiance, 3, 'ambientStrength', 'number', positive),
      slot(ambient, 0, 'ambientColor', 'color'),
    ],
  };
}
interface GLTFMaterialShape {
  name?: string;
  base: number[];
  factors: number[];
  emission: number[];
  settings: number[];
  wireframe?: boolean;
  shading?: { version?: number };
}
function materialObject(id: string, m: GLTFMaterialShape): PackageObject {
  const base = m.base;
  return {
    id,
    group: 'material',
    label: `Material ${m.name || id.slice(9)} (gltf-pro)`,
    target: m,
    properties: [
      slot(base, 0, 'baseColor', 'color', unit),
      slot(base, 3, 'opacity', 'number', unit),
      slot(m.factors, 0, 'roughness', 'number', unit),
      slot(m.factors, 1, 'metallic', 'number', unit),
      slot(m.factors, 2, 'normalScale', 'number'),
      slot(m.factors, 3, 'occlusionStrength', 'number', unit),
      slot(m.emission, 0, 'emissive', 'color', positive),
      slot(m.settings, 1, 'alphaCutoff', 'number', positive),
      slot(m.settings, 2, 'doubleSided', 'boolean'),
      field(m as unknown as Record<string, unknown>, 'wireframe', 'boolean', anyNumber, false),
    ],
    // A shading with a version reuses last frame's uniforms while the version holds, so a write here would not show.
    readOnly:
      m.shading?.version === undefined
        ? undefined
        : 'Its shading (@margoengine/materials) owns these values: edit that Material (pass it in `objects`).',
  };
}
function effectObject(plugin: EnginePlugin, group: 'shadows' | 'effect'): PackageObject {
  const options = (plugin as { options?: unknown }).options,
    table = optionTables[plugin.name] ?? {},
    properties: PackageProperty[] = [];
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const record = options as Record<string, unknown>;
    for (const [key, [fallback, min, max]] of Object.entries(table))
      if (record[key] === undefined || typeof record[key] === 'number')
        properties.push(field(record, key, 'number', [min, max], fallback));
    for (const p of describeObject(options, {})) if (!(p.key in table)) properties.push(p);
  }
  properties.push(...describeObject(plugin, {}, false));
  return {
    id: `${group}:${plugin.name}`,
    group,
    label: `${plugin.name} (${group === 'shadows' ? 'shadows' : 'effect'})`,
    target: plugin,
    properties,
  };
}

/** Options of `findPackageObjects` and `PackageEditor`. */
export interface PackageObjectsOptions {
  /** Further objects to edit (a `@margoengine/materials` Material, an app's settings), listed under `object`, by label. */
  objects?: Record<string, object>;
}

/**
 * The lights, glTF materials, shadows and post effects attached to `engine`, found by shape without importing their
 * packages: core's sun and ambient, every light in a `clustered*` plugin's `list`, the PBR materials of the scene's
 * glTF/FBX nodes, the `shadows`/`virtual-shadows`/`clustered:shadows` plugins and every other plugin with an `options`
 * object or a settable accessor (bloom, SSAO, tonemapping...).
 */
export function findPackageObjects(
  handle: EngineKernel | Engine,
  options: PackageObjectsOptions = {},
): PackageObject[] {
  const engine = engineRuntime(handle as EngineKernel),
    out: PackageObject[] = [sunObject(engine)];
  for (const plugin of engine.plugins.values()) {
    const list = (plugin as { list?: unknown }).list;
    if (plugin.name.startsWith('clustered') && Array.isArray(list))
      list.forEach((light, i) => {
        if (light && typeof light === 'object')
          out.push(
            lightObject(`light:${plugin.name}:${i}`, `${plugin.name} light ${i}`, light as Record<string, unknown>),
          );
      });
  }
  const materials = new Map<object, string>();
  for (const mesh of engine.scene.meshes.values() as Iterable<Mesh>) {
    const triangles = meshTriangles(mesh);
    if (triangles?.kind !== 'pbr') continue;
    for (const primitive of triangles.source.primitives) {
      const m = primitive.material as unknown as GLTFMaterialShape;
      if (!materials.has(m) && Array.isArray(m.base) && Array.isArray(m.factors)) {
        const id = `material:${materials.size}`;
        materials.set(m, id);
        out.push(materialObject(id, m));
      }
    }
  }
  for (const plugin of engine.plugins.values()) {
    if (plugin.name.startsWith('clustered') && !plugin.name.endsWith('shadows')) continue;
    if (plugin.name.startsWith('inspector')) continue;
    const effect = effectObject(plugin, /shadows$/.test(plugin.name) ? 'shadows' : 'effect');
    if (effect.properties.length) out.push(effect);
  }
  for (const [label, target] of Object.entries(options.objects ?? {}))
    out.push({ id: `object:${label}`, group: 'object', label, target, properties: describeObject(target) });
  return out;
}

const same = (a: PropertyValue, b: PropertyValue): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.every((v, i) => v === b[i]) : a === b;

/**
 * Writes `value` into `object`'s property `key`, checked against its kind and range, and records it in `history` (one
 * undoable step; repeated edits of one property within the history's window merge, as a slider drag). Returns false
 * when the value is already set.
 * @throws TypeError for an unknown key or a value of the wrong kind; RangeError for a number out of range; MargoError
 * `'state'` for a read-only object.
 */
export function editProperty(object: PackageObject, key: string, value: PropertyValue, history?: EditHistory): boolean {
  const property = object.properties.find((p) => p.key === key);
  if (!property) throw new TypeError(`${object.label} has no property ${key}; pick one of its properties`);
  if (object.readOnly) throw margoError('state', `${object.label} is read only: ${object.readOnly}`);
  const numbers =
    property.kind === 'boolean'
      ? typeof value === 'boolean'
        ? []
        : null
      : property.kind === 'number'
        ? typeof value === 'number'
          ? [value]
          : null
        : Array.isArray(value) && value.length === 3
          ? value
          : null;
  if (!numbers) throw new TypeError(`${object.label} ${key} takes a ${property.kind}; pass one`);
  for (const n of numbers) {
    if (!Number.isFinite(n)) throw new RangeError(`${object.label} ${key} must be finite; pass a number`);
    if (n < (property.min ?? -Infinity) || n > (property.max ?? Infinity))
      throw new RangeError(`${object.label} ${key} must be ${property.min} to ${property.max}; pass a value in range`);
  }
  const raw = property.get();
  if (same(raw, value)) return false;
  const before = Array.isArray(raw) ? [...raw] : raw,
    after = Array.isArray(value) ? [...value] : value,
    wasUnset = property.isSet?.() === false;
  property.set(after);
  history?.record({
    label: `Set ${object.label} ${key}`,
    key: `${object.id}:${key}`,
    undo: () => property.set(wasUnset ? (undefined as unknown as PropertyValue) : before),
    redo: () => property.set(after),
  });
  return true;
}

/** Options of `PackageEditor.attach`. */
export interface PackageEditorOptions extends PackageObjectsOptions {
  /** Element for the panel. Default `document.body`. */
  parent?: HTMLElement;
  /** Undo history to record edits in (pass `inspector.history` to share the Inspector's). Default a new one. */
  history?: EditHistory;
}

const css = `
:host{position:fixed;left:12px;top:12px;width:300px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;z-index:10001;display:block;color:#202226;background:#fafbfc;border:1px solid #b9bec7;border-radius:4px;font:12px/1.4 system-ui;letter-spacing:0}
*{box-sizing:border-box}h2{font-size:14px;margin:0;padding:10px 12px;border-bottom:1px solid #d5d9df}details{border-bottom:1px solid #d5d9df;padding:6px 12px}summary{cursor:pointer;font-weight:600}
label{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}input{font:inherit;min-width:0}input[type=number]{width:72px}.axes{display:flex;gap:4px}.axes input{width:56px}
input[type=checkbox]{accent-color:#087e67}input[type=color]{width:48px;height:24px;padding:0}input:disabled{opacity:.5}.note{color:#5d636b;margin:4px 0}
`;

/**
 * A DOM panel that edits every package object `findPackageObjects` finds, grouped by kind, with undo. An engine
 * plugin: `PackageEditor.attach(engine)`; it lists objects again when plugins, lights or meshes come and go.
 */
export class PackageEditor implements EnginePlugin {
  readonly name = 'inspector:packages';
  readonly element: HTMLElement;
  readonly history: EditHistory;
  private engine?: Engine;
  private readonly body: HTMLElement;
  private readonly options: PackageEditorOptions;
  private readonly inputs = new Map<string, { input: HTMLInputElement[]; property: PackageProperty }>();
  private objects: PackageObject[] = [];
  private signature = '';
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;

  static attach(engine: EngineKernel, options: PackageEditorOptions = {}): PackageEditor {
    const editor = new PackageEditor(options);
    engineRuntime(engine).use(editor);
    return editor;
  }
  constructor(options: PackageEditorOptions = {}) {
    this.options = options;
    this.history = options.history ?? new EditHistory();
    const parent = options.parent ?? document.body,
      doc = parent.ownerDocument;
    this.element = doc.createElement('div');
    this.element.dataset.margoPackageEditor = '';
    const root = this.element.attachShadow({ mode: 'open' }),
      style = doc.createElement('style'),
      title = doc.createElement('h2');
    style.textContent = css;
    title.textContent = 'Package objects';
    this.body = doc.createElement('div');
    root.append(style, title, this.body);
    parent.append(this.element);
    this.history.onChange(() => this.sync());
  }
  setup(engine: Engine): void {
    if (this.disposed || this.engine)
      throw margoError('attached', 'PackageEditor is disposed or already attached; create a new PackageEditor');
    this.engine = engine;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 500);
  }
  /** The objects listed now. */
  get list(): readonly PackageObject[] {
    return this.objects;
  }
  /** Lists the objects again when what is attached changed, and shows every value as it is now. */
  refresh(): void {
    if (!this.engine || this.disposed) return;
    const objects = findPackageObjects(this.engine, this.options),
      signature = objects.map((o) => o.id + ':' + o.properties.map((p) => p.key).join(',')).join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      this.objects = objects;
      this.build();
    }
    this.sync();
  }
  /** `editProperty` on a listed object, by id, recorded in this editor's history. */
  set(id: string, key: string, value: PropertyValue): boolean {
    const object = this.objects.find((o) => o.id === id);
    if (!object) throw new TypeError(`No package object ${id}; pick an id from list`);
    const changed = editProperty(object, key, value, this.history);
    this.sync();
    return changed;
  }
  private build(): void {
    const doc = this.element.ownerDocument;
    this.inputs.clear();
    this.body.replaceChildren();
    for (const object of this.objects) {
      const section = doc.createElement('details'),
        summary = doc.createElement('summary');
      summary.textContent = object.label;
      section.dataset.object = object.id;
      section.append(summary);
      if (object.readOnly) {
        const note = doc.createElement('p');
        note.className = 'note';
        note.textContent = object.readOnly;
        section.append(note);
      }
      for (const property of object.properties) section.append(this.control(object, property));
      this.body.append(section);
    }
  }
  private control(object: PackageObject, property: PackageProperty): HTMLElement {
    const doc = this.element.ownerDocument,
      label = doc.createElement('label'),
      text = doc.createElement('span'),
      make = (type: string) => {
        const input = doc.createElement('input');
        input.type = type;
        input.disabled = !!object.readOnly;
        if (type === 'number') input.step = 'any';
        return input;
      };
    text.textContent = property.key;
    let inputs: HTMLInputElement[];
    if (property.kind === 'vector') {
      const axes = doc.createElement('span');
      axes.className = 'axes';
      inputs = [0, 1, 2].map((i) => {
        const input = make('number');
        input.setAttribute('aria-label', `${property.key} ${'xyz'[i]}`);
        axes.append(input);
        return input;
      });
      label.append(text, axes);
    } else {
      inputs = [make(property.kind === 'boolean' ? 'checkbox' : property.kind === 'color' ? 'color' : 'number')];
      label.append(text, inputs[0]);
    }
    const read = (): PropertyValue =>
      property.kind === 'boolean'
        ? inputs[0].checked
        : property.kind === 'color'
          ? linearOf(inputs[0].value)
          : property.kind === 'number'
            ? Number(inputs[0].value)
            : inputs.map((i) => Number(i.value));
    for (const input of inputs)
      input.addEventListener(property.kind === 'boolean' ? 'change' : 'input', () => {
        try {
          editProperty(object, property.key, read(), this.history);
          input.setCustomValidity('');
        } catch (error) {
          input.setCustomValidity((error as Error).message);
        }
      });
    this.inputs.set(`${object.id}:${property.key}`, { input: inputs, property });
    return label;
  }
  /** Shows every listed value as it is now (after an undo, or a change made in code). */
  private sync(): void {
    const active = this.element.shadowRoot?.activeElement;
    for (const { input, property } of this.inputs.values()) {
      const value = property.get();
      if (input.includes(active as HTMLInputElement)) continue;
      if (property.kind === 'boolean') input[0].checked = value as boolean;
      else if (property.kind === 'color') input[0].value = hexOf(value as number[]);
      else if (property.kind === 'number') input[0].value = String(value);
      else input.forEach((i, k) => (i.value = String((value as number[])[k])));
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.element.remove();
    this.inputs.clear();
    this.objects = [];
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
