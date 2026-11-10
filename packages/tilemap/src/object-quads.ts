import { rangeError, fault } from '../../shared/errors.js';
import { animatedTile, mapColor } from './chunks.js';
import { FLIP_D, FLIP_H, FLIP_V, GID_MASK, tilesetForGid, type TileMapData, type MapTileset } from './index.js';
import { cellBox } from './layout.js';
import { visibleCells, HEX_ROTATE_120 } from './iso.js';

/** One exact-texel quad in map painter order. Axes include scale, rotation and hexagonal turns. */
export interface TileQuad {
  readonly source: string;
  readonly image: boolean;
  readonly layer: string;
  readonly origin: readonly [number, number];
  readonly axisX: readonly [number, number];
  readonly axisY: readonly [number, number];
  readonly texel: readonly [number, number];
  readonly size: readonly [number, number];
  /** Texture flips: horizontal 1, vertical 2, diagonal 4. */
  readonly flags: number;
  readonly tint: readonly number[];
}

/** Settings for building ordered map quads. No view builds the whole map. */
export interface TileQuadOptions {
  readonly time?: number;
  readonly mapLayers?: readonly string[];
  /** Bounds in map pixels before each layer's offset and parallax. */
  readonly view?: readonly [number, number, number, number];
  readonly camera?: { readonly x: number; readonly y: number };
  readonly parallax?: boolean;
  /** Dimensions of image sources whose metadata omits its size. */
  readonly imageSize?: (source: string) => readonly [number, number] | undefined;
}

function tileImage(set: MapTileset, local: number, time: number) {
  const tile = set.tiles?.find((t) => t.id === local);
  const id = tile?.animation?.length ? animatedTile(tile.animation, time) : local;
  if (set.columns === 0) {
    const image = set.tiles?.find((t) => t.id === id)?.image;
    if (!image) throw fault('state', `Tile ${id} in ${set.name} needs its image`, 'tilemap-options');
    return { source: image.source, image: true, texel: [0, 0] as const, size: [image.width, image.height] as const };
  }
  const margin = set.margin ?? 0,
    spacing = set.spacing ?? 0;
  return {
    source: set.name,
    image: false,
    texel: [
      margin + (id % set.columns) * (set.tileWidth + spacing),
      margin + Math.floor(id / set.columns) * (set.tileHeight + spacing),
    ] as const,
    size: [set.tileWidth, set.tileHeight] as const,
  };
}

/** Build tile cells, tile objects and image layers together, preserving map, cell and object order. */
export function buildMapQuads(map: TileMapData, options: TileQuadOptions = {}): TileQuad[] {
  const out: TileQuad[] = [],
    time = options.time ?? 0,
    hex = map.orientation === 'hexagonal';
  let reach = Math.max(map.tileWidth, map.tileHeight);
  for (const set of map.tilesets) {
    reach = Math.max(reach, set.tileWidth, set.tileHeight);
    for (const t of set.tiles ?? []) if (t.image) reach = Math.max(reach, t.image.width, t.image.height);
    reach += Math.max(Math.abs(set.tileOffset?.[0] ?? 0), Math.abs(set.tileOffset?.[1] ?? 0));
  }
  for (const layer of map.layers) {
    if (
      layer.visible === false ||
      layer.opacity === 0 ||
      (options.mapLayers && !options.mapLayers.includes(layer.name))
    )
      continue;
    const camera = options.camera ?? { x: 0, y: 0 },
      parallax = options.parallax !== false;
    const ox = (layer.offset?.[0] ?? 0) - camera.x * (parallax ? (layer.parallax?.[0] ?? 1) : 1);
    const oy = (layer.offset?.[1] ?? 0) - camera.y * (parallax ? (layer.parallax?.[1] ?? 1) : 1);
    const color = mapColor(layer.tint) ?? [1, 1, 1, 1];
    const tint = [color[0], color[1], color[2], color[3] * (layer.opacity ?? 1)];
    const add = (
      source: string,
      image: boolean,
      x: number,
      y: number,
      w: number,
      h: number,
      texel: readonly [number, number],
      size: readonly [number, number],
      flags = 0,
      angle = 0,
      anchorX = 0,
      anchorY = 0,
    ) => {
      if (![x, y, w, h, angle, ...size].every(Number.isFinite) || w < 0 || h < 0 || size.some((v) => v <= 0))
        throw rangeError('Invalid map image dimensions or transform', 'tilemap-options');
      if (!w || !h) return;
      const c = Math.cos(angle),
        s = Math.sin(angle),
        ax = [c * w, s * w] as const,
        ay = [-s * h, c * h] as const;
      const origin = [ox + x - ax[0] * anchorX - ay[0] * anchorY, oy + y - ax[1] * anchorX - ay[1] * anchorY] as const;
      if (options.view) {
        const xs = [origin[0], origin[0] + ax[0], origin[0] + ay[0], origin[0] + ax[0] + ay[0]];
        const ys = [origin[1], origin[1] + ax[1], origin[1] + ay[1], origin[1] + ax[1] + ay[1]];
        const [l, t, r, b] = options.view;
        if (Math.max(...xs) <= l || Math.min(...xs) >= r || Math.max(...ys) <= t || Math.min(...ys) >= b) return;
      }
      out.push({ source, image, layer: layer.name, origin, axisX: ax, axisY: ay, texel, size, flags, tint });
    };
    const tile = (
      value: number,
      x: number,
      y: number,
      object?: { width?: number; height?: number; rotation?: number },
    ) => {
      const gid = value & GID_MASK,
        set = tilesetForGid(map, gid);
      if (!set) return;
      const image = tileImage(set, gid - set.firstGid, time),
        diagonal = !hex && !!(value & FLIP_D);
      const nativeW = diagonal ? image.size[1] : image.size[0],
        nativeH = diagonal ? image.size[0] : image.size[1];
      const w = object?.width ?? nativeW,
        h = object?.height ?? nativeH;
      const flags = (value & FLIP_H ? 1 : 0) | (value & FLIP_V ? 2 : 0) | (diagonal ? 4 : 0);
      let angle = ((object?.rotation ?? 0) * Math.PI) / 180;
      let ax = 0,
        ay = 0;
      if (object) {
        const alignment =
          set.objectAlignment && set.objectAlignment !== 'unspecified'
            ? set.objectAlignment
            : map.orientation === 'isometric'
              ? 'bottom'
              : 'bottomleft';
        ax = alignment.includes('left') ? 0 : alignment.includes('right') ? 1 : 0.5;
        ay = alignment.includes('top') ? 0 : alignment.includes('bottom') ? 1 : 0.5;
      }
      const dx = (set.tileOffset?.[0] ?? 0) * (object ? w / nativeW : 1);
      const dy = (set.tileOffset?.[1] ?? 0) * (object ? h / nativeH : 1);
      x += dx * Math.cos(angle) - dy * Math.sin(angle);
      y += dx * Math.sin(angle) + dy * Math.cos(angle);
      if (!object) y -= h;
      if (hex && value & (FLIP_D | HEX_ROTATE_120)) {
        x += w * (0.5 - ax);
        y += h * (0.5 - ay);
        ax = ay = 0.5;
        angle += (((value & FLIP_D ? 1 : 0) + (value & HEX_ROTATE_120 ? 2 : 0)) * Math.PI) / 3;
      }
      add(image.source, image.image, x, y, w, h, image.texel, image.size, flags, angle, ax, ay);
    };
    if (layer.type === 'tile') {
      const v = options.view ?? [0, 0, Infinity, Infinity];
      const cells = visibleCells(map, layer, [
        v[0] - ox - reach,
        v[1] - oy - reach,
        v[2] - ox + reach,
        v[3] - oy + reach,
      ]);
      if ((map.orientation ?? 'orthogonal') === 'orthogonal' && map.renderOrder && map.renderOrder !== 'right-down') {
        const up = map.renderOrder.endsWith('up'),
          left = map.renderOrder.startsWith('left');
        cells.sort(
          (a, b) =>
            (Math.floor(a / layer.width) - Math.floor(b / layer.width)) * (up ? -1 : 1) ||
            ((a % layer.width) - (b % layer.width)) * (left ? -1 : 1),
        );
      }
      for (const cell of cells) {
        const box = cellBox(map, cell % layer.width, Math.floor(cell / layer.width));
        tile(layer.data[cell], box.x, box.y + box.height);
      }
    } else if (layer.type === 'object') {
      const objects = layer.drawOrder === 'index' ? layer.objects : [...layer.objects].sort((a, b) => a.y - b.y);
      for (const o of objects) if (o.visible !== false && o.gid) tile(o.gid, o.x, o.y, o);
    } else {
      const image = layer.image,
        size = options.imageSize?.(image.source);
      const w = image.width ?? size?.[0],
        h = image.height ?? size?.[1];
      if (!(w && h)) throw fault('state', `Image ${image.source} needs its dimensions`, 'tilemap-options');
      const view = options.view ?? [0, 0, map.width * map.tileWidth, map.height * map.tileHeight];
      const x0 = layer.repeatX ? Math.floor((view[0] - ox) / w) : 0,
        x1 = layer.repeatX ? Math.ceil((view[2] - ox) / w) : 1;
      const y0 = layer.repeatY ? Math.floor((view[1] - oy) / h) : 0,
        y1 = layer.repeatY ? Math.ceil((view[3] - oy) / h) : 1;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) add(image.source, true, x * w, y * h, w, h, [0, 0], [w, h]);
    }
  }
  return out;
}
