// Independent reader of the public JSON format specification. No runtime implementation source was consulted.
import { fault } from '../../shared/errors.js';

/** A losslessly retained JSON value, including exporter metadata and physics parameters. */
export type SpineValue = null | boolean | number | string | SpineValue[] | SpineObject;
/** A JSON object in an exported skeleton. Optional properties keep the exporter's defaults. */
export interface SpineObject {
  [key: string]: SpineValue | undefined;
}
/** A diagnostic emitted once per physics constraint when the document is loaded. */
export interface SpineWarning {
  code: 'spine-physics-deferred';
  constraint: string;
  message: string;
}
/** Reader resource limits. Defaults: 1,000,000 JSON values and vertices; 64 levels of JSON nesting. */
export interface SpineReadOptions {
  maxValues?: number;
  maxVertices?: number;
  /** Checked before parsing and between sections. */
  signal?: AbortSignal;
}

export const fail = (message: string): never => {
  throw fault('failed', `Invalid skeletal JSON: ${message}`, 'sprite-options');
};
export const obj = (v: SpineValue | undefined): SpineObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : fail('expected an object');
export const arr = (v: SpineValue | undefined): SpineValue[] => (Array.isArray(v) ? v : fail('expected an array'));
export const num = (v: SpineValue | undefined, fallback = 0): number =>
  v === undefined ? fallback : typeof v === 'number' && Number.isFinite(v) ? v : fail('expected a finite number');
export const str = (v: SpineValue | undefined, fallback = ''): string =>
  v === undefined ? fallback : typeof v === 'string' ? v : fail('expected a string');
export const bool = (v: SpineValue | undefined, fallback = false): boolean =>
  v === undefined ? fallback : typeof v === 'boolean' ? v : fail('expected a boolean');
export const objects = (v: SpineValue | undefined): SpineObject[] => (v === undefined ? [] : arr(v).map(obj));
export const record = (v: SpineValue | undefined): SpineObject => (v === undefined ? {} : obj(v));
export const names = (v: SpineValue | undefined): string[] => (v === undefined ? [] : arr(v).map((n) => str(n)));
export const values = (v: SpineValue | undefined): number[] => arr(v).map((n) => num(n));
export const named = (v: SpineValue | undefined, label: string): Map<string, SpineObject> => {
  const map = new Map<string, SpineObject>();
  for (const item of objects(v)) {
    const name = str(item.name);
    if (!name || map.has(name)) fail(`empty or duplicate ${label} name ${name}`);
    map.set(name, item);
  }
  return map;
};
export const ref = (name: string, map: ReadonlyMap<string, unknown>, label: string): void => {
  if (!map.has(name)) fail(`unknown ${label} ${name}`);
};
const integer = (v: SpineValue | undefined, minimum = 0): number => {
  const n = num(v);
  if (!Number.isSafeInteger(n) || n < minimum) fail('expected a nonnegative integer');
  return n;
};
const enumValue = (v: SpineValue | undefined, allowed: string[]) => {
  if (v !== undefined && !allowed.includes(str(v))) fail(`unknown value ${str(v)}`);
};
const color = (v: SpineValue | undefined) => {
  if (v !== undefined && !/^(?:[\da-f]{6}|[\da-f]{8})$/i.test(str(v))) fail('expected RGB or RGBA hex color');
};
const numeric = (o: SpineObject, fields: string) => {
  for (const k of fields.split(' ')) if (o[k] !== undefined) num(o[k]);
};
const booleans = (o: SpineObject, fields: string) => {
  for (const k of fields.split(' ')) if (o[k] !== undefined) bool(o[k]);
};

/** @internal The normalized skin map; old object skins and modern array skins have identical behavior. */
export const skinMap = (data: SpineObject): Map<string, SpineObject> => {
  if (Array.isArray(data.skins)) return named(data.skins, 'skin');
  return new Map(
    Object.entries(record(data.skins)).map(([name, attachments]) => [name, { name, attachments: obj(attachments) }]),
  );
};
export const attachmentKey = (skin: string, slot: string, name: string): string => JSON.stringify([skin, slot, name]);
export const constraintList = (data: SpineObject): { kind: string; data: SpineObject }[] => {
  if (data.constraints !== undefined)
    return objects(data.constraints).map((c, i) => ({
      kind: str(c.type),
      data: { ...c, target: c.target ?? c.source ?? c.slot, order: c.order ?? i },
    }));
  return ['ik', 'transform', 'path', 'physics']
    .flatMap((kind) => objects(data[kind]).map((c) => ({ kind, data: c })))
    .sort((a, b) => num(a.data.order) - num(b.data.order));
};

/** @internal Fully validate before allocating rig or mesh buffers. Unknown metadata is retained. */
export function readData(input: unknown, options: SpineReadOptions): SpineObject {
  options.signal?.throwIfAborted();
  const limit = options.maxValues ?? 1_000_000,
    vertexLimit = options.maxVertices ?? 1_000_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(vertexLimit) || vertexLimit < 1)
    fail('invalid resource limit');
  let count = 0;
  const copy = (v: unknown, depth: number): SpineValue => {
    if (++count > limit || depth > 64) fail('JSON resource limit exceeded');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return num(v);
    if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1));
    if (
      v &&
      typeof v === 'object' &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
    )
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x, depth + 1)]));
    return fail('input must contain only JSON values');
  };
  let source: unknown = input;
  if (typeof input === 'string') {
    if (input.length > limit * 128) fail('JSON text resource limit exceeded');
    try {
      source = JSON.parse(input);
    } catch (e) {
      if (e instanceof SyntaxError) fail('malformed JSON text');
      throw e;
    }
  }
  const data = obj(copy(source, 0));
  const bones = named(data.bones, 'bone'),
    slots = named(data.slots, 'slot'),
    skins = skinMap(data);
  if (!bones.size) fail('at least one bone is required');
  const placed = new Set<string>();
  for (const [name, b] of bones) {
    if (b.parent !== undefined && !placed.has(str(b.parent))) fail(`bone ${name} has an unknown or later parent`);
    placed.add(name);
    numeric(b, 'x y rotation scaleX scaleY shearX shearY length');
    if (num(b.length) < 0) fail('negative bone length');
    booleans(b, 'skin');
    color(b.color);
    enumValue(b.transform ?? b.inherit, [
      'normal',
      'onlyTranslation',
      'noRotationOrReflection',
      'noScale',
      'noScaleOrReflection',
    ]);
  }
  for (const s of slots.values()) {
    ref(str(s.bone), bones, 'slot bone');
    color(s.color);
    color(s.dark);
    if (s.attachment !== undefined) str(s.attachment);
    enumValue(s.blend, ['normal', 'additive', 'add', 'multiply', 'screen']);
  }
  const constraints = new Map<string, Map<string, SpineObject>>();
  const unified = constraintList(data);
  for (const c of unified) enumValue(c.kind, ['ik', 'transform', 'path', 'physics', 'slider']);
  const sliders = named(
    unified.filter((c) => c.kind === 'slider').map((c) => c.data),
    'slider',
  );
  constraints.set('slider', sliders);
  for (const c of sliders.values()) {
    ref(str(c.animation), new Map(Object.entries(record(data.animations))), 'slider animation');
    if (c.bone !== undefined) ref(str(c.bone), bones, 'slider bone');
    enumValue(c.property, ['rotation', 'rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY']);
    booleans(c, 'local additive loop skin');
    numeric(c, 'time mix offset scale max');
  }
  for (const kind of ['ik', 'transform', 'path', 'physics']) {
    const list = named(
      unified.filter((c) => c.kind === kind).map((c) => c.data),
      kind,
    );
    constraints.set(kind, list);
    for (const [name, c] of list) {
      integer(c.order);
      booleans(
        c,
        'skin local relative localSource localTarget additive clamp bendPositive compress stretch uniform inertiaGlobal strengthGlobal dampingGlobal massGlobal windGlobal gravityGlobal mixGlobal',
      );
      numeric(
        c,
        'rotate rotation x y scaleX scaleY shearX shearY mix softness rotateMix translateMix scaleMix shearMix mixRotate mixX mixY mixScaleX mixScaleY mixShearY position spacing limit fps step inertia strength damping mass massInverse wind gravity',
      );
      if (kind === 'physics') {
        ref(str(c.bone), bones, 'physics bone');
        for (const k of ['mass', 'fps', 'step'])
          if (c[k] !== undefined && num(c[k]) <= 0) fail(`physics ${name}: ${k} must be positive`);
        for (const k of ['massInverse', 'damping', 'strength', 'limit', 'inertia'])
          if (c[k] !== undefined && num(c[k]) < 0) fail(`physics ${name}: ${k} must be nonnegative`);
      } else {
        const chain = names(c.bones ?? (c.bone === undefined ? undefined : [c.bone]));
        if (!chain.length || new Set(chain).size !== chain.length) fail(`${kind} needs distinct bones`);
        chain.forEach((n) => ref(n, bones, 'constraint bone'));
        ref(str(c.target), kind === 'path' ? slots : bones, 'constraint target');
        if (kind === 'ik' && (chain.length > 2 || (chain.length === 2 && bones.get(chain[1])!.parent !== chain[0])))
          fail('IK needs one bone or a parent-child pair');
        if (kind !== 'path') {
          let t: string | undefined = str(c.target);
          while (t !== undefined) {
            if (chain.includes(t)) fail('constraint target is a constrained descendant');
            t = bones.get(t)?.parent as string | undefined;
          }
        }
      }
      if (kind === 'path') {
        enumValue(c.positionMode, ['fixed', 'percent']);
        enumValue(c.spacingMode, ['length', 'fixed', 'percent', 'proportional']);
        enumValue(c.rotateMode, ['tangent', 'chain', 'chainScale', 'chain scale']);
      }
      if (kind === 'transform' && c.properties !== undefined)
        for (const [from, value] of Object.entries(obj(c.properties))) {
          enumValue(from, ['rotation', 'rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY']);
          const p = obj(value);
          numeric(p, 'offset');
          for (const [to, raw] of Object.entries(record(p.to))) {
            enumValue(to, ['rotation', 'rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY']);
            numeric(obj(raw), 'offset scale max');
          }
        }
    }
  }
  let vertexTotal = 0;
  const attachments = new Map<string, SpineObject>();
  for (const [skinName, skin] of skins) {
    names(skin.bones).forEach((n) => ref(n, bones, 'skin bone'));
    names(skin.constraints).forEach((n) =>
      ref(n, new Map(unified.map((c) => [str(c.data.name), c.data])), 'skin constraint'),
    );
    for (const kind of constraints.keys())
      names(skin[kind]).forEach((n) => ref(n, constraints.get(kind)!, `skin ${kind}`));
    for (const [slot, aa] of Object.entries(record(skin.attachments))) {
      ref(slot, slots, 'attachment slot');
      for (const [name, raw] of Object.entries(obj(aa))) {
        if (!name) fail('empty attachment name');
        const a = obj(raw),
          type = str(a.type, 'region');
        enumValue(type, [
          'region',
          'mesh',
          'linkedmesh',
          'skinnedmesh',
          'weightedmesh',
          'boundingbox',
          'path',
          'point',
          'clipping',
        ]);
        attachments.set(attachmentKey(skinName, slot, name), a);
        numeric(a, 'x y rotation scaleX scaleY width height hull vertexCount');
        color(a.color);
        booleans(a, 'closed constantSpeed deform');
        for (const k of ['name', 'path', 'parent', 'skin', 'end']) if (a[k] !== undefined) str(a[k]);
        if (a.end !== undefined) ref(str(a.end), slots, 'clipping end');
        if (type === 'region') {
          if (num(a.width) <= 0 || num(a.height) <= 0) fail('region needs positive width and height');
        }
        if (a.sequence !== undefined) {
          const s = obj(a.sequence),
            n = integer(s.count, 1);
          integer(s.start);
          integer(s.digits);
          integer(s.setup);
          if (num(s.setup) >= n) fail('sequence setup index out of range');
        }
        if (type === 'region' || type === 'point' || type === 'linkedmesh') continue;
        const uvs = a.uvs === undefined ? undefined : values(a.uvs);
        const vertices = values(a.vertices),
          n = uvs ? uvs.length / 2 : integer(a.vertexCount, 1);
        if (!Number.isSafeInteger(n) || n < 1 || (vertexTotal += n) > vertexLimit)
          fail('vertex count or vertex resource limit exceeded');
        if (vertices.length !== n * 2) {
          let at = 0;
          for (let i = 0; i < n; i++) {
            const influences = integer(vertices[at++], 1);
            if (at + influences * 4 > vertices.length) fail('truncated weighted vertex');
            let sum = 0;
            for (let j = 0; j < influences; j++, at += 4) {
              if (integer(vertices[at]) >= bones.size || vertices[at + 3] < 0)
                fail('weighted vertex joint or weight out of range');
              sum += vertices[at + 3];
            }
            if (!(sum > 0) || !Number.isFinite(sum)) fail('weighted vertex has no finite positive weight');
          }
          if (at !== vertices.length) fail('trailing weighted vertex data');
        }
        if (type === 'mesh' || type === 'weightedmesh' || type === 'skinnedmesh') {
          if (!uvs || n < 3) fail('mesh needs UV pairs');
          const triangles = values(a.triangles);
          if (
            !triangles.length ||
            triangles.length % 3 ||
            triangles.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= n)
          )
            fail('invalid mesh triangles');
        }
        if (type === 'clipping' && n < 3) fail('clipping needs a polygon');
        if (type === 'path') {
          if (n < 6 || n % 3) fail('path needs cubic control triples');
          if (a.lengths !== undefined) {
            const lengths = values(a.lengths);
            if (lengths.some((n, i) => n < 0 || (i > 0 && n < lengths[i - 1]))) fail('path lengths must increase');
          }
        }
      }
    }
  }
  const resolve = (key: string, seen = new Set<string>()): SpineObject => {
    if (seen.has(key)) return fail('linked mesh cycle');
    const a = attachments.get(key);
    if (!a) return fail('missing linked mesh parent');
    if (str(a.type, 'region') !== 'linkedmesh') {
      if (!['mesh', 'weightedmesh', 'skinnedmesh'].includes(str(a.type))) fail('linked mesh parent must be a mesh');
      return a;
    }
    seen.add(key);
    const [, slot] = JSON.parse(key) as string[];
    return resolve(attachmentKey(str(a.skin, 'default'), slot, str(a.parent)), seen);
  };
  for (const [key, a] of attachments) if (a.type === 'linkedmesh') resolve(key);
  for (const e of Object.values(record(data.events))) {
    const o = obj(e);
    numeric(o, 'int float volume balance');
    if (o.int !== undefined && !Number.isSafeInteger(o.int)) fail('event int must be an integer');
    for (const k of ['string', 'audio']) if (o[k] !== undefined) str(o[k]);
  }
  const timeline = (raw: SpineValue | undefined) => {
    let previous = -1;
    for (const k of objects(raw)) {
      const t = num(k.time);
      if (t < 0 || t < previous) fail('timeline times must increase');
      previous = t;
      numeric(
        k,
        'value angle x y offset int float volume balance mix softness rotateMix translateMix scaleMix shearMix mixRotate mixX mixY mixScaleX mixScaleY mixShearY position spacing delay index inertia strength damping mass wind gravity',
      );
      booleans(k, 'bendPositive compress stretch');
      for (const [name, v] of Object.entries(k)) {
        if (['vertices', 'offsets', 'curve'].includes(name)) continue;
        if (['color', 'light', 'dark', 'rgb', 'rgba', 'rgb2'].includes(name)) color(v);
      }
      if (k.curve !== undefined && k.curve !== 'stepped' && k.curve !== 'linear') {
        const c = typeof k.curve === 'number' ? [num(k.curve), num(k.c2), num(k.c3, 1), num(k.c4, 1)] : values(k.curve);
        if (!c.length || c.length % 4) fail('Bezier controls must come in groups of four');
      }
    }
  };
  for (const animation of Object.values(record(data.animations))) {
    options.signal?.throwIfAborted();
    const a = obj(animation);
    for (const [name, raw] of Object.entries(record(a.bones))) {
      ref(name, bones, 'animated bone');
      for (const [type, keys] of Object.entries(obj(raw))) {
        enumValue(type, [
          'rotate',
          'translate',
          'translatex',
          'translatey',
          'scale',
          'scalex',
          'scaley',
          'shear',
          'shearx',
          'sheary',
          'inherit',
        ]);
        timeline(keys);
      }
    }
    for (const [name, raw] of Object.entries(record(a.slots))) {
      ref(name, slots, 'animated slot');
      for (const [type, keys] of Object.entries(obj(raw))) {
        enumValue(type, ['attachment', 'color', 'twoColor', 'rgba', 'rgb', 'alpha', 'rgba2', 'rgb2']);
        timeline(keys);
      }
    }
    for (const kind of ['ik', 'transform', 'path', 'paths', 'physics', 'slider']) {
      const modern = Object.fromEntries(
        Object.entries(record(a.constraints)).filter(
          ([name]) =>
            constraints.get(kind === 'paths' ? 'path' : kind)?.has(name) || (kind === 'physics' && name === ''),
        ),
      );
      for (const [name, raw] of Object.entries(record(a[kind] ?? modern))) {
        if (!(kind === 'physics' && name === ''))
          ref(name, constraints.get(kind === 'paths' ? 'path' : kind)!, 'animated constraint');
        if (Array.isArray(raw)) timeline(raw);
        else
          for (const [channel, keys] of Object.entries(obj(raw))) {
            if (kind === 'path' || kind === 'paths')
              enumValue(channel, ['position', 'spacing', 'mix', 'mixRotate', 'mixX', 'mixY']);
            if (kind === 'physics')
              enumValue(channel, ['inertia', 'strength', 'damping', 'mass', 'wind', 'gravity', 'mix', 'reset']);
            timeline(keys);
          }
      }
    }
    for (const name of Object.keys(record(a.constraints)))
      if (!unified.some((c) => c.data.name === name) && name !== '') fail(`unknown animated constraint ${name}`);
    const deformation = (raw: SpineValue | undefined, sequence: boolean) => {
      for (const [skin, ss] of Object.entries(record(raw)))
        for (const [slot, aa] of Object.entries(obj(ss)))
          for (const [name, keys] of Object.entries(obj(aa))) {
            const key = attachmentKey(skin, slot, name),
              attachment = attachments.get(key) ?? fail('unknown animated attachment');
            const channels = Array.isArray(keys) ? { [sequence ? 'sequence' : 'deform']: keys } : obj(keys);
            for (const [channel, frames] of Object.entries(channels)) {
              enumValue(channel, ['deform', 'sequence']);
              timeline(frames);
              if (channel === 'sequence') {
                if (!attachment.sequence) fail('sequence timeline requires a sequence');
                for (const k of objects(frames)) {
                  enumValue(k.mode, [
                    'hold',
                    'once',
                    'loop',
                    'pingpong',
                    'onceReverse',
                    'loopReverse',
                    'pingpongReverse',
                  ]);
                  integer(k.index);
                  if (k.delay !== undefined && num(k.delay) <= 0) fail('sequence delay must be positive');
                }
              } else {
                const parent = attachment.type === 'linkedmesh' ? resolve(key) : attachment;
                const v = values(parent.vertices),
                  n = parent.uvs === undefined ? num(parent.vertexCount) : values(parent.uvs).length / 2;
                let length = n * 2;
                if (v.length !== length) {
                  length = 0;
                  for (let at = 0; at < v.length; ) {
                    const count = v[at++];
                    length += count * 2;
                    at += count * 4;
                  }
                }
                for (const k of objects(frames))
                  if (integer(k.offset) + (k.vertices === undefined ? 0 : values(k.vertices).length) > length)
                    fail('deform range exceeds attachment');
              }
            }
          }
    };
    deformation(a.deform ?? a.ffd, false);
    deformation(a.attachments, true);
    timeline(a.events);
    for (const k of objects(a.events)) ref(str(k.name), new Map(Object.entries(record(data.events))), 'event');
    timeline(a.drawOrder ?? a.draworder);
    for (const k of objects(a.drawOrder ?? a.draworder)) {
      const occupied = new Set<number>(),
        moved = new Set<string>(),
        order = [...slots.keys()];
      let previous = -1;
      for (const o of objects(k.offsets)) {
        const name = str(o.slot);
        ref(name, slots, 'draw order slot');
        const index = order.indexOf(name),
          target = index + num(o.offset);
        if (
          index <= previous ||
          moved.has(name) ||
          !Number.isInteger(target) ||
          target < 0 ||
          target >= order.length ||
          occupied.has(target)
        )
          fail('invalid draw order offsets');
        moved.add(name);
        occupied.add(target);
        previous = index;
      }
    }
  }
  return data;
}

/** @internal Find duration without discarding events, deform, constraint or sequence timelines. */
export function duration(value: SpineValue | undefined): number {
  if (Array.isArray(value)) return value.reduce<number>((maximum, v) => Math.max(maximum, duration(v)), 0);
  if (value && typeof value === 'object')
    return Object.values(value)
      .filter((v) => typeof v === 'object')
      .reduce<number>((maximum, v) => Math.max(maximum, duration(v)), num(value.time));
  return 0;
}
