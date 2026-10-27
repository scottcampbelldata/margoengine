// The schema with every field kind and the seeded random values that the codec and generator tests share.
import { defineSchema } from '../dist/index.js';

/** A schema with every field kind. */
export const every = defineSchema({
  version: 3,
  types: {
    Vec: { x: 'f32', y: 'f32' },
    Item: { name: { type: 'string', maxLength: 16 }, count: 'u16' },
    Entity: {
      position: 'Vec',
      heading: { type: 'f32', interpolate: 'angle' },
      health: { type: 'quantized', min: 0, max: 100, bits: 10 },
      kind: { type: 'enum', values: ['player', 'crate', 'bullet'] },
      alive: 'bool',
      tag: { type: 'optional', of: 'string' },
      items: { type: 'array', of: 'Item', maxLength: 8 },
      parent: { type: 'optional', of: 'Entity' },
    },
    All: {
      a: 'u8',
      b: 'u16',
      c: 'u32',
      d: 'i8',
      e: 'i16',
      f: 'i32',
      g: 'uint',
      h: 'int',
      i: 'f64',
      j: 'bytes',
      entities: { type: 'map', of: 'Entity', maxSize: 32 },
      scores: { type: 'map', of: 'int', maxSize: 32 },
    },
  },
});

// Random values of a normalized field, from a seeded stream; depth-limited for recursive structs.
export function generator(schema, random) {
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  const value = (field, depth) => {
    switch (field.type) {
      case 'bool':
        return random() < 0.5;
      case 'u8':
        return int(0, 255);
      case 'u16':
        return int(0, 65535);
      case 'u32':
      case 'uint':
        return random() < 0.3 ? int(0, 300) : int(0, 2 ** 32 - 1);
      case 'i8':
        return int(-128, 127);
      case 'i16':
        return int(-32768, 32767);
      case 'i32':
      case 'int':
        return random() < 0.3 ? int(-300, 300) : int(-(2 ** 31), 2 ** 31 - 1);
      case 'f32':
      case 'f64':
        return random() < 0.2 ? 0 : (random() - 0.5) * 10 ** int(-3, 6);
      case 'quantized':
        return field.min + random() * (field.max - field.min);
      case 'string':
        return Array.from({ length: int(0, Math.min(field.maxLength / 2, 6)) }, () =>
          String.fromCodePoint(random() < 0.8 ? int(32, 126) : int(0x400, 0x4ff)),
        ).join('');
      case 'bytes':
        return Uint8Array.from({ length: int(0, 8) }, () => int(0, 255));
      case 'enum':
        return field.values[int(0, field.values.length - 1)];
      case 'array':
        return Array.from({ length: depth > 2 ? 0 : int(0, 3) }, () => value(field.of, depth + 1));
      case 'optional':
        return depth > 2 || random() < 0.4 ? undefined : value(field.of, depth + 1);
      case 'map': {
        const map = new Map();
        for (let n = depth > 2 ? 0 : int(0, 6); map.size < n; ) map.set(int(0, 40), value(field.of, depth + 1));
        return map;
      }
      case 'struct':
        return struct(field.name, depth + 1);
    }
    throw new Error(field.type);
  };
  const struct = (name, depth = 0) => {
    const out = {};
    for (const [key, field] of Object.entries(schema.json.types[name])) {
      const v = value(field, depth);
      if (v !== undefined) out[key] = v;
    }
    return out;
  };
  // A copy of `v` with some fields changed, entries added and removed: what the next tick looks like.
  const mutate = (name, v) => {
    const out = structuredClone(v);
    for (const [key, field] of Object.entries(schema.json.types[name])) {
      if (random() < 0.5) continue;
      if (field.type === 'map' && out[key]) {
        for (const id of [...out[key].keys()]) if (random() < 0.2) out[key].delete(id);
        for (const [id, entry] of out[key])
          if (random() < 0.4)
            out[key].set(id, field.of.type === 'struct' ? mutate(field.of.name, entry) : value(field.of, 1));
        if (random() < 0.5) out[key].set(int(41, 60), value(field.of, 1));
      } else if (field.type === 'struct') out[key] = mutate(field.name, out[key]);
      else {
        const next = value(field, 1);
        if (next === undefined) delete out[key];
        else out[key] = next;
      }
    }
    return out;
  };
  return { struct, mutate };
}
