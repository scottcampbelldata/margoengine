import { readXMLTree, decodeXML, type XMLElement } from '@margoengine/loaders/xml';
import { setOwn, type Obj } from './import.js';

const strings = new Set([
  'name',
  'type',
  'class',
  'source',
  'image',
  'template',
  'color',
  'fontfamily',
  'halign',
  'valign',
  'orientation',
  'renderorder',
  'draworder',
  'staggeraxis',
  'staggerindex',
  'tintcolor',
  'backgroundcolor',
  'encoding',
  'compression',
  'objectalignment',
]);
const booleans = new Set([
  'visible',
  'wrap',
  'bold',
  'italic',
  'underline',
  'strikeout',
  'kerning',
  'repeatx',
  'repeaty',
  'infinite',
  'hflip',
  'vflip',
  'dflip',
  'rotate',
  'preferuntransformed',
]);
function attributes(e: XMLElement): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e.attributes))
    setOwn(
      result,
      key,
      strings.has(key)
        ? value
        : booleans.has(key)
          ? value === '1' || value === 'true'
          : Number.isFinite(Number(value))
            ? Number(value)
            : value,
    );
  return result;
}
function element(e: XMLElement): Obj {
  const o = attributes(e);
  if (e.name === 'map') o.tilesets = [];
  if (e.name === 'map' || e.name === 'group') o.layers = [];
  if (e.name === 'objectgroup') o.objects = [];
  if (e.name === 'property') {
    const raw = e.attributes.value ?? e.text,
      type = e.attributes.type ?? 'string';
    o.value =
      type === 'bool'
        ? raw === 'true' || raw === '1'
        : type === 'int' || type === 'float' || type === 'object'
          ? Number(raw)
          : raw;
    const nested = e.children.find((c) => c.name === 'properties');
    if (nested)
      o.value = Object.fromEntries(
        nested.children.map((p) => {
          const v = element(p);
          return [String(v.name), v.value];
        }),
      );
  }
  if (e.name === 'text') o.text = e.text;
  if (e.name === 'polygon' || e.name === 'polyline')
    return {
      points: (e.attributes.points ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((pair) => {
          const [x, y] = pair.split(',').map(Number);
          return { x, y };
        }),
    };
  if (e.name === 'wangtile') o.wangid = (e.attributes.wangid ?? '').split(',').map(Number);
  for (const child of e.children) {
    const v = element(child),
      push = (key: string) => {
        ((o[key] ??= []) as unknown[]).push(v);
      };
    if (child.name === 'properties') o.properties = child.children.map(element);
    else if (child.name === 'image') {
      o.image = child.attributes.source;
      o.imagewidth = v.width;
      o.imageheight = v.height;
    } else if (
      ['layer', 'objectgroup', 'imagelayer', 'group'].includes(child.name) &&
      (e.name === 'map' || e.name === 'group')
    ) {
      push('layers');
      (v as Record<string, unknown>).type = child.name === 'layer' ? 'tilelayer' : child.name;
    } else if (child.name === 'object') e.name === 'template' ? (o.object = v) : push('objects');
    else if (child.name === 'tileset') e.name === 'template' ? (o.tileset = v) : push('tilesets');
    else if (child.name === 'tile' && e.name === 'tileset') push('tiles');
    else if (child.name === 'tile' && e.name === 'data')
      ((o.data ??= []) as number[]).push(Number(child.attributes.gid ?? 0));
    else if (child.name === 'data') {
      Object.assign(o, v);
      if (!child.children.length)
        o.data =
          child.attributes.encoding === 'csv'
            ? child.text
                .trim()
                .split(/[\s,]+/)
                .filter(Boolean)
                .map(Number)
            : child.text.trim();
    } else if (child.name === 'chunk') {
      push('chunks');
      (v as Record<string, unknown>).data =
        e.attributes.encoding === 'csv'
          ? child.text
              .trim()
              .split(/[\s,]+/)
              .filter(Boolean)
              .map(Number)
          : child.text.trim();
    } else if (child.name === 'polygon' || child.name === 'polyline') o[child.name] = v.points;
    else if (child.name === 'ellipse' || child.name === 'point') o[child.name] = true;
    else if (child.name === 'animation') o.animation = child.children.map(element);
    else if (child.name === 'wangsets') o.wangsets = child.children.map(element);
    else if (child.name === 'wangcolor' || child.name === 'wangcornercolor' || child.name === 'wangedgecolor')
      push('colors');
    else if (child.name === 'wangtile') push('wangtiles');
    else o[child.name] = v;
  }
  return o;
}

/** Convert standard Tiled XML maps, tilesets and templates to the JSON field model before semantic import. */
export function tiledXML(input: string | Uint8Array): Obj {
  const tree = readXMLTree(typeof input === 'string' ? input : decodeXML(input), 'Tiled');
  if (tree.children.length !== 1 || !['map', 'tileset', 'template'].includes(tree.children[0].name))
    throw new TypeError('Expected a Tiled map, tileset or template XML document; pass the file contents.');
  return element(tree.children[0]);
}
