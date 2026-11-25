import { MargoError } from "@margoengine/math/errors";
import type { Entity, World } from "./index.js";
import type { Schedule } from "./schedule.js";

/** Value kinds of a script attribute. `vec2`, `vec3` and `vec4` hold number arrays; `color` is `[r, g, b, a]` in 0..1; `asset` is an id string. */
export type AttributeType =
  | "number"
  | "boolean"
  | "string"
  | "enum"
  | "vec2"
  | "vec3"
  | "vec4"
  | "color"
  | "entity"
  | "asset";
/** One declared attribute. `default` is validated when the script is defined. */
export interface AttributeSpec {
  type: AttributeType;
  /** Default value. Default: 0, false, '', the first option, zeros, [1, 1, 1, 1] for color, or null for entity and asset. */
  default?: unknown;
  /** Smallest number, or smallest vector/color element. Default none. */
  min?: number;
  /** Largest number, or largest vector/color element. Default none. */
  max?: number;
  /** Allowed values of an `enum` (strings or numbers). Required for `enum`. */
  options?: readonly (string | number)[];
  /** Label for an inspector. Default: the attribute name. */
  title?: string;
  /** Asset kind hint for an inspector ('texture', 'model'...). Default none. */
  assetKind?: string;
}
/** Attribute declarations by name. */
export type AttributeSpecs = Record<string, AttributeSpec>;
/** A live attribute value set (getters and setters that validate). */
export type AttributeValues = Record<string, any>;

/** A running script. Hooks are called with it as `this`. */
export interface ScriptInstance {
  readonly entity: Entity;
  readonly world: World;
  readonly type: ScriptType;
  /** Validated attributes; assigning one runs `onAttributeChange`. */
  readonly attributes: AttributeValues;
  /** Free-form state the script owns; it survives a hot reload. */
  state: Record<string, any>;
  /** True while the instance receives updates. Assign to enable or disable it. */
  enabled: boolean;
  /** True after `initialize` ran, until `destroy`. */
  readonly initialized: boolean;
}
/** Lifecycle hooks of a script. All optional. */
export interface ScriptHooks {
  /** Once, on the first update after the instance is added and enabled. `onEnable` runs just before it. */
  initialize?(this: ScriptInstance): void;
  /** Once, after every `initialize` of that batch has run. */
  postInitialize?(this: ScriptInstance): void;
  /** Every `Scripts.update`, with the frame time. */
  update?(this: ScriptInstance, dt: number): void;
  /** Every `Scripts.update`, after all `update` hooks. */
  postUpdate?(this: ScriptInstance, dt: number): void;
  /** Every `Scripts.fixedUpdate`, with the fixed step. */
  fixedUpdate?(this: ScriptInstance, step: number): void;
  onEnable?(this: ScriptInstance): void;
  onDisable?(this: ScriptInstance): void;
  /** An attribute was assigned a different value. */
  onAttributeChange?(
    this: ScriptInstance,
    name: string,
    value: any,
    previous: any,
  ): void;
  /** Instance removed, entity destroyed, or registry disposed; `onDisable` ran first when it was enabled. */
  destroy?(this: ScriptInstance): void;
  /** Hot reload: called on the instance of the NEW type with the type it replaces, to migrate `state`. */
  swap?(this: ScriptInstance, previous: ScriptType): void;
}
/** Definition passed to {@link defineScript}. */
export interface ScriptDefinition extends ScriptHooks {
  /** Unique name within a registry; hot reload matches by it. */
  name: string;
  attributes?: AttributeSpecs;
  /** Run order across instances, lowest first, ties by order of `add`. Default 0. */
  priority?: number;
}
/** A defined script type. */
export interface ScriptType extends ScriptHooks {
  readonly name: string;
  readonly priority: number;
  readonly attributes: Readonly<
    Record<string, Readonly<AttributeSpec & { title: string }>>
  >;
}
/** The hook that failed, for {@link ScriptsOptions.onError}. */
export type ScriptHook = keyof ScriptHooks;
/** Settings of {@link Scripts}. */
export interface ScriptsOptions {
  /**
   * Called for every error a script throws, so one failing script never stops the others. Default: errors are
   * collected and rethrown after the pass as one MargoError `'failed'` whose `cause` is the first.
   */
  onError?: (
    error: unknown,
    info: { script: ScriptInstance; hook: ScriptHook },
  ) => void;
}
/** Options of {@link Scripts.add}. */
export interface AddScriptOptions {
  /** Attribute values; others use defaults. */
  values?: Record<string, unknown>;
  /** Start enabled. Default true. */
  enabled?: boolean;
}

const VEC: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4, color: 4 };
const KINDS = [
  "number",
  "boolean",
  "string",
  "enum",
  "entity",
  "asset",
  ...Object.keys(VEC),
];
const HOOKS = [
  "initialize",
  "postInitialize",
  "update",
  "postUpdate",
  "fixedUpdate",
  "onEnable",
  "onDisable",
  "onAttributeChange",
  "destroy",
  "swap",
] as const;
const hex = (s: string): number[] | undefined => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return undefined;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(1);
};
const bad = (name: string, spec: { type: string }, why: string): RangeError =>
  new RangeError(`Invalid ${spec.type} attribute ${name}: ${why}`);

/** Validate and normalise one attribute value. @throws RangeError naming the attribute. */
function coerce(name: string, spec: AttributeSpec, value: unknown): any {
  const { type, min = -Infinity, max = Infinity } = spec;
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw bad(name, spec, "use a finite number");
    if (value < min || value > max)
      throw bad(name, spec, `${value} is outside ${min}..${max}`);
    return value;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") throw bad(name, spec, "use true or false");
    return value;
  }
  if (type === "string") {
    if (typeof value !== "string") throw bad(name, spec, "use a string");
    return value;
  }
  if (type === "enum") {
    if (!spec.options!.includes(value as string))
      throw bad(name, spec, `use one of ${spec.options!.join(", ")}`);
    return value;
  }
  if (type === "entity") {
    if (value !== null && !(Number.isInteger(value) && (value as number) >= 0))
      throw bad(name, spec, "use an entity id or null");
    return value;
  }
  if (type === "asset") {
    if (value !== null && (typeof value !== "string" || !value))
      throw bad(name, spec, "use an asset id string or null");
    return value;
  }
  const size = VEC[type];
  const list =
    type === "color" && typeof value === "string" ? hex(value) : value;
  if (
    !(Array.isArray(list) || ArrayBuffer.isView(list)) ||
    (list as ArrayLike<number>).length !== size
  )
    throw bad(
      name,
      spec,
      `use ${size} numbers${type === "color" ? " or a #rrggbb string" : ""}`,
    );
  const out = Array.from(list as ArrayLike<number>);
  const lo = type === "color" ? Math.max(min, 0) : min,
    hi = type === "color" ? Math.min(max, 1) : max;
  for (const n of out) {
    if (typeof n !== "number" || !Number.isFinite(n))
      throw bad(name, spec, "use finite numbers");
    if (n < lo || n > hi) throw bad(name, spec, `${n} is outside ${lo}..${hi}`);
  }
  return out;
}
const same = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => v === b[i])
    : a === b;
const clone = (v: any): any => (Array.isArray(v) ? [...v] : v);

function defaultOf(spec: AttributeSpec): unknown {
  switch (spec.type) {
    case "number":
      return 0;
    case "boolean":
      return false;
    case "string":
      return "";
    case "enum":
      return spec.options![0];
    case "color":
      return [1, 1, 1, 1];
    case "entity":
    case "asset":
      return null;
    default:
      return new Array(VEC[spec.type]).fill(0);
  }
}

/**
 * Declare a script type: typed attributes plus lifecycle hooks. Register it with {@link Scripts.register}.
 * @throws TypeError for a missing name, an unknown attribute type or a hook that is not a function.
 * @throws RangeError for a default outside its own min/max or options.
 */
export function defineScript(def: ScriptDefinition): ScriptType {
  if (!def || typeof def.name !== "string" || !def.name)
    throw new TypeError("Invalid script; give it a non-empty name");
  const attributes: Record<string, AttributeSpec & { title: string }> = {};
  for (const [key, raw] of Object.entries(def.attributes ?? {})) {
    if (!raw || !KINDS.includes(raw.type))
      throw new TypeError(
        `Unknown attribute type for ${def.name}.${key}; use number, boolean, string, enum, vec2, vec3, vec4, color, entity or asset`,
      );
    if (
      raw.type === "enum" &&
      (!Array.isArray(raw.options) || !raw.options.length)
    )
      throw new TypeError(
        `Enum attribute ${def.name}.${key} needs a non-empty options list`,
      );
    const spec = { ...raw, title: raw.title ?? key };
    spec.default = coerce(
      key,
      spec,
      raw.default === undefined ? defaultOf(spec) : raw.default,
    );
    attributes[key] = Object.freeze(spec);
  }
  const type: Record<string, unknown> = {
    name: def.name,
    priority: def.priority ?? 0,
    attributes: Object.freeze(attributes),
  };
  for (const hook of HOOKS) {
    if (def[hook] === undefined) continue;
    if (typeof def[hook] !== "function")
      throw new TypeError(`Script ${def.name} hook ${hook} is not a function`);
    type[hook] = def[hook];
  }
  return Object.freeze(type) as unknown as ScriptType;
}

interface Inst {
  entity: Entity;
  world: World;
  type: ScriptType;
  state: Record<string, any>;
  attributes: AttributeValues;
  values: Record<string, any>;
  isEnabled: boolean;
  isInitialized: boolean;
  seq: number;
  dead: boolean;
}

/**
 * Script components for a {@link World}: add scripts to entities, run their hooks, hot reload them. One registry per
 * world; nothing is global. `using scripts = new Scripts(world)` destroys every instance at scope end.
 */
export class Scripts {
  private readonly types = new Map<string, ScriptType>();
  private all: Inst[] = [];
  private readonly byEntity = new Map<Entity, Inst[]>();
  private pending: Inst[] = [];
  private seq = 0;
  private errors: unknown[] = [];
  private busy = false;
  private disposed = false;
  private readonly store = {
    remove: (entity: Entity): void => this.removeAll(entity),
  };
  constructor(
    readonly world: World,
    private readonly options: ScriptsOptions = {},
  ) {
    world.attach(this.store);
  }
  /** Register a script type; it must be registered before `add`. @throws TypeError when the name is taken (use {@link Scripts.reload}). */
  register(type: ScriptType): this {
    this.live();
    if (this.types.has(type.name))
      throw new TypeError(
        `Script ${type.name} is already registered; use reload to replace it`,
      );
    this.types.set(type.name, type);
    return this;
  }
  /** The registered type of that name, or undefined. */
  get(name: string): ScriptType | undefined {
    return this.types.get(name);
  }
  /** Inspector schema of every registered type, as plain JSON-safe data. */
  schema(): {
    name: string;
    priority: number;
    attributes: {
      name: string;
      type: AttributeType;
      default: unknown;
      title: string;
    }[];
  }[] {
    return [...this.types.values()].map((t) => ({
      name: t.name,
      priority: t.priority,
      attributes: Object.entries(t.attributes).map(([name, s]) =>
        JSON.parse(JSON.stringify({ name, ...s })),
      ),
    }));
  }
  /**
   * Attach a script to an entity, after the scripts it already has. Its hooks start on the next update or fixedUpdate.
   * @throws MargoError `'state'` for a stale entity, an unregistered type or a disposed registry.
   * @throws RangeError for an unknown or invalid attribute value.
   */
  add(
    entity: Entity,
    type: ScriptType | string,
    { values = {}, enabled = true }: AddScriptOptions = {},
  ): ScriptInstance {
    this.live();
    this.world.check(entity);
    const name = typeof type === "string" ? type : type.name;
    const t = this.types.get(name);
    if (!t)
      throw new MargoError(
        "state",
        `Script ${name} is not registered; call register first`,
      );
    for (const key of Object.keys(values))
      if (!(key in t.attributes))
        throw new RangeError(
          `Unknown attribute ${key} for script ${t.name}; declare it in attributes`,
        );
    const inst: Inst = {
      entity,
      world: this.world,
      type: t,
      state: {},
      attributes: {},
      values: {},
      seq: this.seq++,
      dead: false,
      isInitialized: false,
      isEnabled: !!enabled,
    };
    for (const [key, spec] of Object.entries(t.attributes))
      inst.values[key] = coerce(
        key,
        spec,
        key in values ? values[key] : spec.default,
      );
    this.shape(inst);
    Object.defineProperties(inst, {
      enabled: {
        enumerable: true,
        get: () => inst.isEnabled,
        set: (v: boolean) => this.setEnabled(inst, !!v),
      },
      initialized: { enumerable: true, get: () => inst.isInitialized },
    });
    this.all.push(inst);
    this.sortAll();
    const list = this.byEntity.get(entity);
    if (list) list.push(inst);
    else this.byEntity.set(entity, [inst]);
    this.pending.push(inst);
    return inst as unknown as ScriptInstance;
  }
  /** Instances on an entity, in the order they were added. */
  on(entity: Entity): readonly ScriptInstance[] {
    return (this.byEntity.get(entity) ?? []) as unknown as ScriptInstance[];
  }
  /**
   * Remove one instance, or every script of an entity (only those of `type` when given). Each runs `onDisable` (when
   * enabled) then `destroy` if it had been initialised. Returns the number removed.
   */
  remove(target: ScriptInstance | Entity, type?: ScriptType | string): number {
    this.live();
    if (typeof target !== "number")
      return this.kill(target as unknown as Inst) ? 1 : 0;
    const name = typeof type === "string" ? type : type?.name;
    const list = (this.byEntity.get(target) ?? []).filter(
      (i) => name === undefined || i.type.name === name,
    );
    this.pass(() => list.forEach((i) => this.kill(i)));
    return list.length;
  }
  /** Run pending `onEnable`, `initialize` and `postInitialize` hooks now; `update` and `fixedUpdate` call this first. */
  flush(): void {
    this.live();
    this.pass(() => {
      for (;;) {
        const batch = this.pending.filter((i) => !i.dead && i.isEnabled);
        if (!batch.length) break;
        this.pending = this.pending.filter((i) => !i.dead && !i.isEnabled);
        batch.sort(
          (a, b) => a.type.priority - b.type.priority || a.seq - b.seq,
        );
        for (const i of batch) {
          if (i.dead || i.isInitialized) continue;
          this.call(i, "onEnable");
          i.isInitialized = true;
          this.call(i, "initialize");
        }
        for (const i of batch) if (!i.dead) this.call(i, "postInitialize");
      }
    });
  }
  /** One frame: flush, then `update` of every enabled instance, then `postUpdate`. @throws RangeError for a negative or non-finite `dt`. */
  update(dt: number): void {
    this.step(dt, ["update", "postUpdate"]);
  }
  /** One fixed step: flush, then `fixedUpdate` of every enabled instance. */
  fixedUpdate(step: number): void {
    this.step(step, ["fixedUpdate"]);
  }
  /** Add a frame system `scripts` (update, postUpdate) and a fixed system `scripts.fixed` (fixedUpdate) to a {@link Schedule}. */
  install(
    schedule: Schedule,
    options: { before?: readonly string[]; after?: readonly string[] } = {},
  ): this {
    schedule.add("scripts.fixed", (t) => this.fixedUpdate(t.delta), {
      fixed: true,
    });
    schedule.add("scripts", (t) => this.update(t.delta), options);
    return this;
  }
  /**
   * Hot reload: replace the registered type of the same name with a new implementation. Instances stay, with their
   * attribute values (kept where the attribute still exists and is valid, otherwise reset to the new default), `state`,
   * enabled flag and order. The new type's `swap(previous)` runs on each to migrate state. `initialize` runs again
   * only with `reinitialize: true` (after `onDisable` and `destroy` of the old version, with `state` cleared).
   * A type that is not registered yet is just registered. Returns the number of instances swapped.
   */
  reload(
    next: ScriptType,
    { reinitialize = false }: { reinitialize?: boolean } = {},
  ): number {
    this.live();
    const old = this.types.get(next.name);
    this.types.set(next.name, next);
    if (!old) return 0;
    let n = 0;
    this.pass(() => {
      for (const inst of this.all.filter((i) => i.type === old)) {
        const again = reinitialize && inst.isInitialized;
        if (again) {
          if (inst.isEnabled) this.call(inst, "onDisable");
          this.call(inst, "destroy");
        }
        const kept = inst.values;
        inst.type = next;
        inst.values = {};
        for (const [key, spec] of Object.entries(next.attributes)) {
          try {
            inst.values[key] =
              key in kept ? coerce(key, spec, kept[key]) : clone(spec.default);
          } catch {
            inst.values[key] = clone(spec.default);
          }
        }
        this.shape(inst);
        if (again) {
          inst.isInitialized = false;
          inst.state = {};
          this.pending.push(inst);
        }
        this.call(inst, "swap", old);
        n++;
      }
      this.sortAll();
    });
    return n;
  }
  /** Destroy every instance and detach from the world. Safe to call twice. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.detach(this.store);
    this.pass(() => [...this.all].forEach((i) => this.kill(i)));
  }
  /** Same as `[Symbol.dispose]()`. */
  dispose(): void {
    this[Symbol.dispose]();
  }

  private live(): void {
    if (this.disposed)
      throw new MargoError(
        "disposed",
        "Scripts is disposed; create a new Scripts",
      );
  }
  private sortAll(): void {
    this.all.sort((a, b) => a.type.priority - b.type.priority || a.seq - b.seq);
  }
  private shape(inst: Inst): void {
    const attrs: AttributeValues = {};
    for (const [key, spec] of Object.entries(inst.type.attributes)) {
      Object.defineProperty(attrs, key, {
        enumerable: true,
        get: () => clone(inst.values[key]),
        set: (v) => {
          const next = coerce(key, spec, v);
          const prev = inst.values[key];
          if (same(prev, next)) return;
          inst.values[key] = next;
          if (inst.isInitialized && !inst.dead)
            this.pass(() =>
              this.call(
                inst,
                "onAttributeChange",
                key,
                clone(next),
                clone(prev),
              ),
            );
        },
      });
    }
    inst.attributes = Object.freeze(attrs);
  }
  private setEnabled(inst: Inst, on: boolean): void {
    if (inst.dead || inst.isEnabled === on) return;
    inst.isEnabled = on;
    if (!inst.isInitialized) {
      if (on && !this.pending.includes(inst)) this.pending.push(inst);
      return; // the first enable happens in flush: onEnable, then initialize
    }
    this.pass(() => this.call(inst, on ? "onEnable" : "onDisable"));
  }
  private kill(inst: Inst): boolean {
    if (inst.dead) return false;
    inst.dead = true;
    this.all = this.all.filter((i) => i !== inst);
    this.pending = this.pending.filter((i) => i !== inst);
    const list = (this.byEntity.get(inst.entity) ?? []).filter(
      (i) => i !== inst,
    );
    if (list.length) this.byEntity.set(inst.entity, list);
    else this.byEntity.delete(inst.entity);
    if (inst.isInitialized) {
      this.pass(() => {
        if (inst.isEnabled) this.call(inst, "onDisable");
        this.call(inst, "destroy");
      });
      inst.isInitialized = false;
    }
    return true;
  }
  private removeAll(entity: Entity): void {
    this.pass(() =>
      [...(this.byEntity.get(entity) ?? [])].forEach((i) => this.kill(i)),
    );
  }
  private call(inst: Inst, hook: ScriptHook, ...args: any[]): void {
    const fn = inst.type[hook] as ((...a: any[]) => void) | undefined;
    if (!fn) return;
    try {
      fn.apply(inst, args);
    } catch (error) {
      if (this.options.onError)
        this.options.onError(error, {
          script: inst as unknown as ScriptInstance,
          hook,
        });
      else this.errors.push(error);
    }
  }
  private step(
    dt: number,
    hooks: ("update" | "postUpdate" | "fixedUpdate")[],
  ): void {
    this.live();
    if (!Number.isFinite(dt) || dt < 0)
      throw new RangeError(
        "Invalid script delta; pass a finite number of seconds, 0 or more",
      );
    this.flush();
    this.pass(() => {
      for (const hook of hooks)
        for (const inst of [...this.all])
          if (!inst.dead && inst.isEnabled && inst.isInitialized)
            this.call(inst, hook, dt);
    });
  }
  /** Run `body`; errors collected without an onError handler are rethrown once, at the end of the outermost pass. */
  private pass(body: () => void): void {
    if (this.busy) return body();
    this.busy = true;
    try {
      body();
    } finally {
      this.busy = false;
    }
    if (this.errors.length) {
      const n = this.errors.length;
      const error = new MargoError(
        "failed",
        `${n} script hook${n > 1 ? "s" : ""} threw; the first error is in cause, or pass onError to handle each`,
      );
      Object.defineProperty(error, "cause", { value: this.errors[0] });
      this.errors = [];
      throw error;
    }
  }
}
