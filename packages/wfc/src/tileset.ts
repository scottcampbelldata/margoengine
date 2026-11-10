import type { Tile } from './index.js';
/** The six Gumin symmetry classes; F retains all eight dihedral orientations. */
export type TileSymmetry = 'X' | 'I' | '\\' | 'L' | 'T' | 'F';
/** One named source tile. Weight defaults to 1 per distinct orientation, matching Gumin tilesets. */
export interface NamedTile {
  name: string;
  symmetry?: TileSymmetry;
  weight?: number;
}
/** A horizontal left/right rule; names may end with an orientation action 0..7. */
export interface TileNeighbor {
  left: string;
  right: string;
}
/** Solver-ready variant with an assembly-compatible source and column-major 3x3 transform. */
export interface TilesetVariant extends Tile {
  name: string;
  source: number;
  orientation: number;
  rotation: readonly number[];
}
/** Authored tiles, rules and optional named tile subsets. */
export interface TilesetDefinition {
  tiles: readonly NamedTile[];
  neighbors: readonly TileNeighbor[];
  subsets?: Readonly<Record<string, readonly string[]>>;
}
const fail = () =>
  new RangeError(
    'Invalid WFC tileset; provide distinct tile names, X/I/\\/L/T/F symmetry and valid named neighbor orientations',
  );
function symmetry(s: TileSymmetry) {
  const n = s === 'F' ? 8 : s === 'L' || s === 'T' ? 4 : s === 'X' ? 1 : 2;
  const a = (i: number) => (n === 8 ? (i < 4 ? (i + 1) % 4 : 4 + ((i + 3) % 4)) : (i + 1) % n);
  const b = (i: number) =>
    s === 'L'
      ? i % 2
        ? i - 1
        : i + 1
      : s === 'T'
        ? i % 2
          ? 4 - i
          : i
        : s === '\\'
          ? 1 - i
          : s === 'F'
            ? (i + 4) % 8
            : i;
  const action = (i: number, g: number) => {
    for (let k = 0; k < g % 4; k++) i = a(i);
    return g < 4 ? i : b(i);
  };
  return { n, action };
}
// Actions 0..3 are +Y quarter turns; 4..7 reflect X after those turns.
function transform(g: number) {
  const k = g % 4,
    c = [1, 0, -1, 0][k],
    s = [0, 1, 0, -1][k],
    m = g < 4 ? 1 : -1;
  return [m * c, 0, -s, 0, 1, 0, m * s, 0, c];
}
/** Expand classes and the full D4 orbit of each neighbor rule; vertical neighbors are unconstrained. Subset defaults to all tiles. */
export function buildTileset(definition: TilesetDefinition, subset?: string): TilesetVariant[] {
  if (!definition.tiles.length || definition.tiles.length > 4096) throw fail();
  const names = new Map<string, number>(),
    specs = Array.from(definition.tiles, (t) => {
      if (
        !t ||
        typeof t.name !== 'string' ||
        !t.name.trim() ||
        /\s[0-7]$/.test(t.name) ||
        names.has(t.name) ||
        !['X', 'I', '\\', 'L', 'T', 'F'].includes(t.symmetry ?? 'X') ||
        !Number.isFinite(t.weight ?? 1) ||
        (t.weight ?? 1) <= 0
      )
        throw fail();
      names.set(t.name, names.size);
      return symmetry(t.symmetry ?? 'X');
    });
  const selected = subset === undefined ? definition.tiles.map((t) => t.name) : definition.subsets?.[subset];
  if (
    !selected?.length ||
    Array.from(selected).some((n) => !names.has(n)) ||
    new Set(selected).size !== selected.length
  )
    throw fail();
  const include = new Set(selected),
    bases: number[] = [],
    out: TilesetVariant[] = [];
  definition.tiles.forEach((tile, source) => {
    bases[source] = out.length;
    if (!include.has(tile.name)) return;
    const spec = specs[source];
    if (out.length + spec.n > 4096) throw fail();
    for (let i = 0; i < spec.n; i++)
      out.push({
        name: tile.name,
        source,
        orientation: i,
        rotation: transform(i),
        weight: tile.weight ?? 1,
        neighbors: Array.from({ length: 6 }, () => []),
      });
  });
  const resolve = (ref: string) => {
    if (typeof ref !== 'string') throw fail();
    const m = /^(.*) ([0-7])$/.exec(ref),
      name = m ? m[1] : ref,
      source = names.get(name);
    if (source === undefined) throw fail();
    return { source, id: specs[source].action(0, m ? Number(m[2]) : 0), active: include.has(name) };
  };
  const edges = out.map(() => Array.from({ length: 6 }, () => new Set<number>()));
  for (const rule of Array.from(definition.neighbors)) {
    if (!rule) throw fail();
    const left = resolve(rule.left),
      right = resolve(rule.right);
    if (!left.active || !right.active) continue;
    for (let g = 0; g < 8; g++) {
      const a = bases[left.source] + specs[left.source].action(left.id, g),
        b = bases[right.source] + specs[right.source].action(right.id, g),
        r = transform(g);
      const d = r[0] === 1 ? 0 : r[0] === -1 ? 1 : r[2] === 1 ? 4 : 5;
      edges[a][d].add(b);
      edges[b][d ^ 1].add(a);
    }
  }
  out.forEach((tile, i) => {
    tile.neighbors = edges[i].map((set, d) =>
      d === 2 || d === 3 ? out.map((_, j) => j) : [...set].sort((a, b) => a - b),
    );
  });
  return out;
}
interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Element[];
}
// Attribute-only XML vocabulary: no DTDs, entities, text content or external resources.
function xml(text: string): Element {
  if (typeof text !== 'string' || text.length > 4_194_304) throw fail();
  const root: Element = { name: '', attrs: {}, children: [] },
    stack = [root];
  let at = 0;
  const decode = (v: string) =>
    v.replace(/&(?:#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);|&/g, (t) => {
      const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (named[t]) return named[t];
      if (t === '&') throw fail();
      const n = parseInt(t.slice(t[2] === 'x' ? 3 : 2, -1), t[2] === 'x' ? 16 : 10);
      if (
        !(
          n === 9 ||
          n === 10 ||
          n === 13 ||
          (n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && n !== 0xfffe && n !== 0xffff)
        )
      )
        throw fail();
      return String.fromCodePoint(n);
    });
  const tokens =
    /<!--(?:[^-]|-(?!-))*-->|<\?[\s\S]*?\?>|<\/[A-Za-z][\w-]*\s*>|<[A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>/g;
  for (const m of text.matchAll(tokens)) {
    if (text.slice(at, m.index).trim()) throw fail();
    at = m.index! + m[0].length;
    const token = m[0];
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    const name = /^<\/?([\w-]+)/.exec(token)![1];
    if (token.startsWith('</')) {
      if (stack.length === 1 || stack.pop()!.name !== name) throw fail();
      continue;
    }
    const el: Element = { name, attrs: Object.create(null), children: [] };
    for (const a of token.matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (a[1] in el.attrs) throw fail();
      el.attrs[a[1]] = decode((a[2] ?? a[3]).replace(/[\t\r\n]/g, ' '));
    }
    stack.at(-1)!.children.push(el);
    if (!token.endsWith('/>')) stack.push(el);
    if (stack.length > 8) throw fail();
  }
  if (text.slice(at).trim() || stack.length !== 1 || root.children.length !== 1 || root.children[0].name !== 'set')
    throw fail();
  return root.children[0];
}
/** Parse Gumin set/tiles/neighbors/subsets XML in Node or browsers, without DOM dependencies or external entity loading. */
export function parseTilesetXML(text: string): TilesetDefinition {
  const root = xml(text),
    sections = new Map(root.children.map((e) => [e.name, e]));
  if (
    sections.size !== root.children.length ||
    root.children.some((e) => !['tiles', 'neighbors', 'subsets'].includes(e.name))
  )
    throw fail();
  const tiles = sections.get('tiles')?.children.map((e) => {
    if (e.name !== 'tile' || e.children.length) throw fail();
    return {
      name: e.attrs.name,
      symmetry: e.attrs.symmetry as TileSymmetry | undefined,
      weight: e.attrs.weight === undefined ? undefined : Number(e.attrs.weight),
    };
  });
  const neighbors = sections.get('neighbors')?.children.map((e) => {
    if (e.name !== 'neighbor' || e.children.length) throw fail();
    return { left: e.attrs.left, right: e.attrs.right };
  });
  if (!tiles || !neighbors) throw fail();
  const subsets: Record<string, string[]> = Object.create(null);
  for (const e of sections.get('subsets')?.children ?? []) {
    if (e.name !== 'subset' || !e.attrs.name || e.attrs.name in subsets) throw fail();
    subsets[e.attrs.name] = e.children.map((t) => {
      if (t.name !== 'tile' || !t.attrs.name || t.children.length) throw fail();
      return t.attrs.name;
    });
  }
  const definition = { tiles, neighbors, subsets };
  buildTileset(definition);
  return definition;
}
