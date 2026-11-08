// The page of iso-check.mjs: GridTileMap read back against images painted on the CPU from cellBox and paintOrder.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { cellBox, GridTileMap, HEX_ROTATE_120, paintOrder } from '/packages/tilemap/dist/iso.js';
import { FLIP_D, FLIP_H, FLIP_V, GID_MASK } from '/packages/tilemap/dist/index.js';

const WIDTH = 64,
  HEIGHT = 48;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:256px;height:192px;image-rendering:pixelated';
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [WIDTH, HEIGHT] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#000000';
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
const frame = () => {
  canvas.width = WIDTH;
  instance.render({ delta: 0 });
  const copy = document.createElement('canvas');
  copy.width = WIDTH;
  copy.height = HEIGHT;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
};

/** An atlas of `count` tiles side by side; `paint(tile, x, y)` gives each texel's RGBA. */
const atlas = (tw, th, count, paint) => {
  const data = new Uint8Array(tw * count * th * 4);
  for (let t = 0; t < count; t++)
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) data.set(paint(t, x, y), (y * tw * count + t * tw + x) * 4);
  return { width: tw * count, height: th, data };
};
// Every texel its own colour, so a wrong texel shows; floor tiles are diamonds, opaque on texel centres inside.
const shade = (t, x, y) => [40 + t * 90 + x * 4, 20 + y * 6, 200 - t * 70 - x * 3, 255];
const diamond = (tw, th) => (t, x, y) =>
  Math.abs(x + 0.5 - tw / 2) / (tw / 2) + Math.abs(y + 0.5 - th / 2) / (th / 2) <= 1 ? shade(t, x, y) : [0, 0, 0, 0];

/**
 * The image a map should give: cells in paint order, each tile's texels laid over its drawn box (bottom left on the cell
 * box), flips undone as Tiled defines them; the last opaque texel wins. With `turn`, pixels whose texel would sit within
 * 0.05 of a texel edge are left out of the check (a turned image's edges fall where rounding decides).
 */
const paint = (map, sheets, camera) => {
  const image = new Array(WIDTH * HEIGHT).fill(null),
    order = paintOrder(map);
  for (const layer of map.layers)
    for (const cell of order) {
      const value = layer.data[cell],
        gid = value & GID_MASK;
      if (!gid) continue;
      const set = [...map.tilesets].reverse().find((s) => gid >= s.firstGid),
        sheet = sheets[set.name],
        id = gid - set.firstGid,
        x = cell % layer.width,
        y = Math.floor(cell / layer.width),
        box = cellBox(map, x, y),
        hex = map.orientation === 'hexagonal',
        diagonal = !hex && (value & FLIP_D) !== 0,
        w = diagonal ? set.tileHeight : set.tileWidth,
        h = diagonal ? set.tileWidth : set.tileHeight,
        left = (box.x - camera.x) * camera.zoom,
        top = (box.y + box.height - h - camera.y) * camera.zoom,
        turn = hex ? ((value & FLIP_D ? 1 : 0) + (value & HEX_ROTATE_120 ? 2 : 0)) * (Math.PI / 3) : 0;
      for (let py = 0; py < HEIGHT; py++)
        for (let px = 0; px < WIDTH; px++) {
          // Undo the turn about the image centre, then the flips.
          // The drawn box is w x h map pixels, so w * zoom x h * zoom on screen.
          const sw = w * camera.zoom,
            sh = h * camera.zoom,
            dx = px + 0.5 - left - sw / 2,
            dy = py + 0.5 - top - sh / 2,
            ux = (dx * Math.cos(-turn) - dy * Math.sin(-turn)) / sw + 0.5,
            uy = (dx * Math.sin(-turn) + dy * Math.cos(-turn)) / sh + 0.5;
          if (!(ux >= 0 && ux < 1 && uy >= 0 && uy < 1)) continue;
          let s = [ux, uy];
          if (value & FLIP_H) s[0] = 1 - s[0];
          if (value & FLIP_V) s[1] = 1 - s[1];
          if (diagonal) s = [s[1], s[0]];
          const tx = s[0] * set.tileWidth,
            ty = s[1] * set.tileHeight,
            near = (v) => Math.abs(v - Math.round(v)) < 0.05;
          if (turn && (near(tx) || near(ty) || near(ux * sw) || near(uy * sh))) {
            image[py * WIDTH + px] = 'skip';
            continue;
          }
          const at = (Math.floor(ty) * sheet.width + id * set.tileWidth + Math.floor(tx)) * 4;
          if (sheet.data[at + 3]) image[py * WIDTH + px] = [...sheet.data.subarray(at, at + 3)];
        }
    }
  return image;
};
const compare = (actual, expected) => {
  let count = 0,
    checked = 0,
    first = null;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === 'skip') continue;
    checked++;
    const want = expected[i] ?? [0, 0, 0],
      got = [actual[i * 4], actual[i * 4 + 1], actual[i * 4 + 2]];
    if (got.join() !== want.join()) {
      count++;
      first ??= { x: i % WIDTH, y: Math.floor(i / WIDTH), got, want };
    }
  }
  return { count, checked, first };
};
const run = (map, sheets, camera) => {
  const tiles = GridTileMap.attach(instance, { map, atlases: sheets, camera });
  try {
    return { ...compare(frame(), paint(map, sheets, camera)), draws: tiles.stats.draws };
  } finally {
    tiles.dispose();
  }
};
const layer = (name, width, height, values) => ({ type: 'tile', name, width, height, data: Uint32Array.from(values) });

window.check = {
  size: () => [canvas.width, canvas.height],
  async run() {
    const out = {};
    engine.gpu.pushErrorScope('validation');
    // Isometric 4 x 3, 16 x 8 diamonds, and walls 16 x 16 from a second tileset that rise over the cells behind.
    const floor = atlas(16, 8, 2, diamond(16, 8)),
      wall = atlas(16, 16, 1, shade),
      sets = [
        { name: 'floor', firstGid: 1, tileWidth: 16, tileHeight: 8, tileCount: 2, columns: 2 },
        { name: 'wall', firstGid: 3, tileWidth: 16, tileHeight: 16, tileCount: 1, columns: 1 },
      ];
    const isoMap = {
      orientation: 'isometric',
      width: 4,
      height: 3,
      tileWidth: 16,
      tileHeight: 8,
      tilesets: sets,
      layers: [
        layer('ground', 4, 3, [1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2]),
        layer('walls', 4, 3, [0, 3, 0, 0, 0, 3, 1 | FLIP_H, 0, 3, 0, 0, 2 | FLIP_V]),
      ],
    };
    out.iso = run(isoMap, { floor, wall }, { x: -4, y: -10, zoom: 1 });
    // Staggered along x, even columns lowered, zoom 2 at a half-cell scroll.
    out.staggered = run(
      {
        ...isoMap,
        orientation: 'staggered',
        staggerAxis: 'x',
        staggerIndex: 'even',
        layers: isoMap.layers.slice(0, 1),
      },
      { floor, wall },
      { x: -2, y: 4, zoom: 2 },
    );
    // Hexagonal, pointy, odd rows pushed: 14 x 16 hexes with side 8; flips and turns of 60 and 120 degrees.
    const hexSheet = atlas(14, 16, 2, (t, x, y) => {
        const cx = Math.abs(x + 0.5 - 7),
          cy = Math.abs(y + 0.5 - 8);
        return cy <= 4 || cx / 7 + (cy - 4) / 4 <= 1 ? shade(t, x, y) : [0, 0, 0, 0];
      }),
      hexMap = {
        orientation: 'hexagonal',
        staggerAxis: 'y',
        staggerIndex: 'odd',
        hexSideLength: 8,
        width: 4,
        height: 3,
        tileWidth: 14,
        tileHeight: 16,
        tilesets: [{ name: 'hex', firstGid: 1, tileWidth: 14, tileHeight: 16, tileCount: 2, columns: 2 }],
        layers: [layer('ground', 4, 3, [1, 2 | FLIP_H, 1, 2, 2 | FLIP_V, 1, 2, 1, 1, 2, 1, 2])],
      };
    out.hex = run(hexMap, { hex: hexSheet }, { x: -2, y: -4, zoom: 1 });
    out.hexTurned = run(
      { ...hexMap, layers: [layer('ground', 4, 3, [1 | FLIP_D, 0, 2 | HEX_ROTATE_120, 0, 0, 0, 0, 0, 0, 0, 0, 0])] },
      { hex: hexSheet },
      { x: -2, y: -4, zoom: 2 },
    );
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    out.errors = errors;
    return out;
  },
};
window.ready = true;
