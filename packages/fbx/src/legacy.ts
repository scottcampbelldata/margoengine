// FBX 6 object/take migration from Autodesk SDK 2005.12 and 2011 guides; see docs/clean-room.md.
import { findChild, invalid, type FBXNode, type FBXValue, type ParseBudget } from './document.js';
import type { ExtensionHooks, FBXExtension } from './extension.js';
import { animationLayers } from './layers.js';

const node = (name: string, properties: FBXValue[] = [], children: FBXNode[] = []): FBXNode => ({
  name,
  properties,
  children,
});
const canonical = (value: unknown): string => {
  const s = String(value),
    i = s.indexOf('\0\x01');
  return i < 0 ? s : `${s.slice(i + 2)}::${s.slice(0, i)}`;
};
const char = (value: FBXValue | undefined): string =>
  typeof value === 'number' ? String.fromCharCode(value) : String(value);

/** Normalize the mixed scalar Key stream, preserving the old C byte tokens in binary files. */
function keys(channel: FBXNode, budget: ParseBudget): FBXNode[] {
  const input = findChild(channel, 'Key')?.properties ?? [],
    count = Number(findChild(channel, 'KeyCount')?.properties[0] ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) invalid('legacy key count');
  budget.array(count * 36);
  const times = new BigInt64Array(count),
    values = new Float32Array(count),
    flags = new Int32Array(count),
    data = new Float32Array(count * 4),
    bits = new Uint32Array(data.buffer);
  let at = 0;
  const number = (): number => {
    const v = input[at++];
    if (typeof v !== 'number' || !Number.isFinite(v)) invalid('legacy key number');
    return v;
  };
  for (let i = 0; i < count; i++) {
    budget.work();
    const time = input[at++];
    if (typeof time !== 'bigint' && (typeof time !== 'number' || !Number.isSafeInteger(time)))
      invalid('legacy key time');
    times[i] = BigInt(time);
    values[i] = number();
    const mode = char(input[at++]);
    if (mode === 'L') {
      flags[i] = 4;
      continue;
    }
    if (mode === 'C') {
      const kind = char(input[at++]);
      if (kind !== 's' && kind !== 'n') invalid('legacy constant mode');
      flags[i] = 2 | (kind === 'n' ? 0x100 : 0);
      continue;
    }
    if (mode === 'T') {
      flags[i] = 8 | 0x200;
      data[i * 4] = number();
      data[i * 4 + 1] = number();
      data[i * 4 + 2] = number();
      continue;
    }
    if (mode !== 'U' && mode !== 'A') invalid(`legacy interpolation ${mode}`);
    const tangent = char(input[at++]);
    if (!['s', 'b', 'a'].includes(tangent)) invalid(`legacy tangent ${tangent}`);
    flags[i] = 8 | (mode === 'A' || tangent === 'a' ? 0x100 : 0x400) | (tangent === 'b' ? 0x800 : 0);
    data[i * 4] = number();
    data[i * 4 + 1] = number();
    const weighted = char(input[at++]);
    if (!['n', 'r', 'l', 'a'].includes(weighted)) invalid(`legacy weight mode ${weighted}`);
    let right = 1 / 3,
      left = 1 / 3;
    if (weighted === 'r' || weighted === 'a') {
      right = number();
      flags[i] |= 0x1000000;
    }
    if (weighted === 'l' || weighted === 'a') {
      left = number();
      flags[i] |= 0x2000000;
    }
    if (right < 0 || right > 1 || left < 0 || left > 1) invalid('legacy tangent weight');
    bits[i * 4 + 2] = Math.round(right * 9999) | (Math.round(left * 9999) << 16);
  }
  if (at !== input.length) invalid('legacy key stream length');
  return [
    node('KeyTime', [times]),
    node('KeyValueFloat', [values]),
    node('KeyAttrFlags', [flags]),
    node('KeyAttrDataFloat', [data]),
  ];
}

function normalize(roots: FBXNode[], version: number, budget: ParseBudget): void {
  if (version >= 7000) return;
  if (version < 6000) invalid(`unsupported version ${version}`);
  const objects = roots.find((n) => n.name === 'Objects');
  if (!objects) invalid('legacy Objects');
  let next = 1n;
  const morphs = new Map<bigint, Map<string, bigint>>();
  const byId = new Map<bigint, FBXNode>();
  const names = new Map<string, bigint>(),
    geometry = new Map<bigint, bigint>(),
    links: FBXNode[] = [];
  const add = (name: string, label: string, type = '', children: FBXNode[] = []): bigint => {
    budget.node(1);
    budget.property(3);
    const key = next++,
      value = node(name, [key, label, type], children);
    objects.children.push(value);
    byId.set(key, value);
    return key;
  };
  const connect = (child: bigint, parent: bigint, property?: string) => {
    budget.node(1);
    budget.property(property ? 4 : 3);
    links.push(node('C', property ? ['OP', child, parent, property] : ['OO', child, parent]));
  };
  // Assign all names before resolving references. The reserved scene name is not an object.
  for (const object of objects.children) {
    budget.work();
    if (typeof object.properties[0] !== 'string') continue;
    const name = canonical(object.properties[0]);
    if (names.has(name)) invalid(`duplicate legacy object ${name}`);
    const key = next++;
    names.set(name, key);
    object.properties = [key, name, ...object.properties.slice(1)];
    byId.set(key, object);
  }
  const resolve = (value: unknown): bigint | undefined => {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    const name = canonical(value);
    return name === 'Model::Scene' ? 0n : names.get(name);
  };
  function properties(source: FBXNode, depth: number): void {
    budget.work();
    if (depth > 64) invalid('legacy nesting');
    if (source.name === 'Properties60') {
      source.name = 'Properties70';
      for (const p of source.children)
        if (p.name === 'Property') {
          p.name = 'P';
          p.properties.splice(3, 0, '');
          budget.property();
        }
    }
    if (source.name === 'Node' && source.properties.length === 1) {
      const key = resolve(source.properties[0]);
      if (key !== undefined) source.properties[0] = key;
    }
    for (const c of source.children) properties(c, depth + 1);
  }
  for (const r of roots) properties(r, 0);
  for (const object of [...objects.children]) {
    if (object.name === 'GlobalSettings') {
      roots.push(object);
      continue;
    }
    const key = object.properties[0];
    if (typeof key !== 'bigint') continue;
    if (object.name === 'Model' && findChild(object, 'Vertices')) {
      const children = object.children.filter(
        (n) =>
          ['Vertices', 'PolygonVertexIndex', 'Edges', 'GeometryVersion', 'Shape'].includes(n.name) ||
          n.name.startsWith('Layer'),
      );
      object.children = object.children.filter((n) => !children.includes(n));
      const mesh = add(
        'Geometry',
        `Geometry::${canonical(object.properties[1])}`,
        String(object.properties[2]),
        children.filter((n) => n.name !== 'Shape'),
      );
      geometry.set(key, mesh);
      connect(mesh, key);
      for (const shape of children.filter((n) => n.name === 'Shape')) {
        const blend = add('Deformer', 'Deformer::BlendShape', 'BlendShape');
        const channel = add('Deformer', canonical(shape.properties[0]), 'BlendShapeChannel', [
          node('DeformPercent', [0]),
          node('FullWeights', [[100]]),
        ]);
        const target = add('Geometry', canonical(shape.properties[0]), 'Shape', shape.children);
        connect(blend, mesh);
        connect(channel, blend);
        connect(target, channel);
        const map = morphs.get(key) ?? new Map<string, bigint>();
        map.set(String(shape.properties[0]), channel);
        morphs.set(key, map);
      }
    }
    if (object.name === 'Texture') {
      const file = findChild(object, 'TextureName');
      if (file && !findChild(object, 'FileName')) object.children.push(node('FileName', file.properties));
    }
  }
  const connections = roots.find((n) => n.name === 'Connections');
  for (const c of connections?.children ?? []) {
    if (c.name !== 'Connect' && c.name !== 'C') continue;
    const kind = c.properties[0];
    if (kind !== 'OO' && kind !== 'OP') continue;
    const child = resolve(c.properties[1]);
    let parent = resolve(c.properties[2]);
    if (child === undefined || parent === undefined) continue;
    const source = byId.get(child);
    if (source?.name === 'Deformer') parent = geometry.get(parent) ?? parent;
    if (source?.name === 'Texture' && kind === 'OO') connect(child, parent, 'DiffuseColor');
    else connect(child, parent, kind === 'OP' ? String(c.properties[3]) : undefined);
  }
  if (connections) connections.children = links;
  else roots.push(node('Connections', [], links));
  for (const take of roots.find((n) => n.name === 'Takes')?.children ?? []) {
    if (take.name !== 'Take') continue;
    const stack = add('AnimationStack', String(take.properties[0])),
      layer = add('AnimationLayer', 'BaseLayer');
    connect(layer, stack);
    for (const target of take.children) {
      const model = resolve(target.properties[0]);
      if (model === undefined || model === 0n) continue;
      const walk = (channels: FBXNode[]) => {
        for (const channel of channels) {
          if (channel.name !== 'Channel') continue;
          const label = String(channel.properties[0]);
          if (label === 'Transform') {
            walk(channel.children);
            continue;
          }
          const property =
            ({ T: 'Lcl Translation', R: 'Lcl Rotation', S: 'Lcl Scaling' } as Record<string, string>)[label] ?? label;
          {
            const track = add('AnimationCurveNode', label),
              morph = morphs.get(model)?.get(label);
            connect(track, layer);
            connect(track, morph ?? model, morph ? 'DeformPercent' : property);
            if (morph) {
              const value = findChild(channel, 'Default')?.properties[0];
              if (value !== undefined)
                byId
                  .get(morph)!
                  .children.push(node('Properties70', [], [node('P', ['DeformPercent', 'Number', '', '', value])]));
            }
            const axes = channel.children.filter((n) => n.name === 'Channel');
            if (!axes.length && findChild(channel, 'KeyCount')) {
              const data = keys(channel, budget);
              if (Number(findChild(channel, 'KeyCount')?.properties[0]))
                connect(add('AnimationCurve', label, '', data), track, 'd|X');
            }
            for (const axis of axes) {
              const axisName = String(axis.properties[0]),
                defaults = findChild(axis, 'Default');
              if (defaults) {
                const out = byId.get(track)!;
                out.children.push(node(`d|${axisName}`, defaults.properties));
              }
              const data = keys(axis, budget);
              if (Number(findChild(axis, 'KeyCount')?.properties[0]))
                connect(add('AnimationCurve', axisName, '', data), track, `d|${axisName}`);
            }
          }
        }
      };
      walk(target.children);
    }
  }
}

/** FBX 6.x binary and ASCII object, inline geometry, Properties60 and Takes normalization, including cubic curves. */
export const legacyFBX: FBXExtension = {
  name: 'legacy',
  minimumVersion: 6000,
  document: normalize,
  curve: (animationLayers as ExtensionHooks).curve,
  blend: (animationLayers as ExtensionHooks).blend,
} as ExtensionHooks;
