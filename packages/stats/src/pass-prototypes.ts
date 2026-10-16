type Counters = { drawCalls: number; dispatches: number };
type Kind = {
  readonly factory: Function;
  readonly prototype: object;
  readonly parent: object | null;
  readonly names: readonly string[];
  readonly originals: readonly Function[];
  readonly probe: object;
  readonly derived: object;
};

/** Internal opt-in layout; ordinary Stats never constructs this helper. */
export class PassPrototypes {
  private readonly getPrototype = Object.getPrototypeOf;
  private readonly setPrototype = Reflect.setPrototypeOf;
  private readonly reflectSet = Reflect.set;
  private readonly own = Object.hasOwn;
  private readonly extensible = Object.isExtensible;
  private readonly lookupGetter = Reflect.get(Object.prototype, '__lookupGetter__') as (this: object, key: string) => unknown;
  private readonly lookupSetter = Reflect.get(Object.prototype, '__lookupSetter__') as (this: object, key: string) => unknown;
  private readonly source = Function.prototype.toString;
  private readonly encoderPrototype?: object;
  private readonly renderKind?: Kind;
  private readonly computeKind?: Kind;

  constructor(private readonly owner: symbol, stats: Counters, renderWrappers: readonly Function[], computeWrappers: readonly Function[]) {
    try {
      if (typeof GPUCommandEncoder !== 'function' || typeof this.lookupGetter !== 'function' ||
        typeof this.lookupSetter !== 'function') return;
      const encoder = GPUCommandEncoder.prototype;
      this.encoderPrototype = encoder;
      if (typeof GPURenderPassEncoder === 'function') {
        const prototype = GPURenderPassEncoder.prototype,
          draw = this.method(prototype, 'draw'),
          indexed = this.method(prototype, 'drawIndexed'),
          indirect = this.method(prototype, 'drawIndirect'),
          indexedIndirect = this.method(prototype, 'drawIndexedIndirect');
        if (draw && indexed && indirect && indexedIndirect)
          this.renderKind = this.capture(prototype, encoder, 'beginRenderPass', owner,
            { stats, draw, indexed, indirect, indexedIndirect },
            ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'], renderWrappers);
      }
      if (typeof GPUComputePassEncoder === 'function') {
        const prototype = GPUComputePassEncoder.prototype,
          dispatch = this.method(prototype, 'dispatchWorkgroups'),
          indirect = this.method(prototype, 'dispatchWorkgroupsIndirect');
        if (dispatch && indirect)
          this.computeKind = this.capture(prototype, encoder, 'beginComputePass', owner,
            { stats, dispatch, indirect }, ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect'], computeWrappers);
      }
    } catch {
      // Unknown hosts keep the ordinary Stats wrapper path.
    }
  }

  // This ordinary-runtime rejection filter is not a security boundary against
  // modified JavaScript intrinsics. It rejects JS overrides, bound functions and
  // proxies without invoking their own toString properties. Runs only at setup.
  private method(prototype: object, name: string): Function | undefined {
    const property = Object.getOwnPropertyDescriptor(prototype, name), fn = property?.value;
    return typeof fn === 'function' &&
      this.source.call(fn).replace(/\s/g, '') === `function${name}(){[nativecode]}` ? fn : undefined;
  }

  private capture(prototype: object, encoder: object, factoryName: string, owner: symbol, record: object,
    wrappedNames: readonly string[], wrappers: readonly Function[]): Kind | undefined {
    const factory = this.method(encoder, factoryName);
    if (!factory) return;
    const names: string[] = [], originals: Function[] = [], probe = Object.create(null);
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const property = Object.getOwnPropertyDescriptor(prototype, name)!;
      if (name === 'constructor' || typeof property.value !== 'function') continue;
      const fn = this.method(prototype, name);
      if (!fn) return;
      names.push(name); originals.push(fn);
      Object.defineProperty(probe, name, { value: fn, writable: true });
    }
    const derived = Object.create(prototype);
    const expose = (key: string | symbol, value: unknown) => {
      Object.defineProperty(derived, key, {
        enumerable: true,
        get() { return value; },
        set(this: object, next: unknown) {
          if (this === derived) throw new TypeError('Shared Stats pass prototype is immutable');
          Object.defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true });
        },
      });
    };
    expose(owner, record);
    for (let i = 0; i < wrappedNames.length; i++) expose(wrappedNames[i], wrappers[i]);
    return { factory, prototype, parent: this.getPrototype(prototype), names, originals, probe,
      derived: Object.freeze(derived) };
  }

  private wrap(pass: object, encoder: object, factory: Function, kind: Kind | undefined): boolean {
    // A successful call to this exact native factory produced the fresh pass.
    // Unknown factories and other realms keep the ordinary wrapper path without
    // inspecting their returned objects or invoking additional accessors.
    if (!kind || factory !== kind.factory || this.getPrototype(encoder) !== this.encoderPrototype ||
      this.getPrototype(pass) !== kind.prototype || !this.extensible(pass) || this.owner in pass ||
      this.getPrototype(kind.prototype) !== kind.parent) return false;
    for (let i = 0; i < kind.names.length; i++) {
      const key = kind.names[i], fn = kind.originals[i];
      if (this.own(pass, key) || !this.own(kind.prototype, key) ||
        this.lookupGetter.call(kind.prototype, key) || this.lookupSetter.call(kind.prototype, key) ||
        (kind.prototype as Record<string, unknown>)[key] !== fn || !this.reflectSet(kind.prototype, key, fn, kind.probe)) return false;
    }
    // Reflect.set above writes only to pre-existing private probe slots. It
    // detects nonwritable inherited data without allocating descriptors; the
    // accessor guards prevent it from invoking user getters or setters.
    try {
      return this.setPrototype(pass, kind.derived);
    } catch {
      return false;
    }
  }

  render(pass: GPURenderPassEncoder, encoder: GPUCommandEncoder, factory: GPUCommandEncoder['beginRenderPass']): boolean {
    return this.wrap(pass, encoder, factory, this.renderKind);
  }
  compute(pass: GPUComputePassEncoder, encoder: GPUCommandEncoder, factory: GPUCommandEncoder['beginComputePass']): boolean {
    return this.wrap(pass, encoder, factory, this.computeKind);
  }
}
