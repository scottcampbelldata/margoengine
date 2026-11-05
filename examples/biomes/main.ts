// Biomes: a 4 km landscape drawn from a @margoengine/biomes world. The climate fields, the biome map, the ground
// materials, the trees and the river water all come from the package (BiomeWorld, BiomeView, BiomeEditor and the /io
// exports); this page only wires controls to them, draws the map beside the terrain and saves the exported files.
import { createStage } from 'margoengine';
import { OrbitControls } from '@margoengine/controls';
import { paceEngine } from '@margoengine/quality';
import { Sky } from '@margoengine/sky';
import {
  BiomeWorld,
  defineBiome,
  type BiomeDefinition,
  type BiomeSample,
  type ClimateOptions,
  type ReliefOptions,
} from '@margoengine/biomes';
import { BiomeEditor } from '@margoengine/biomes/editor';
import { presets, presetWorlds } from '@margoengine/biomes/presets';
import { BiomeView } from '@margoengine/biomes/view';
import { download, tar } from './files.ts';
import { describe, type MapLayer, pretty, WorldMap } from './map.ts';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const input = (id: string) => $<HTMLInputElement>(`#${id}`);
const errorLine = $('#error'),
  statusLine = $('#status'),
  timingLine = $('#timing'),
  probeLine = $('#probe');
const say = (text: string) => {
  statusLine.textContent = text;
};
const report = (error: unknown) => {
  if ((error as Error)?.name === 'AbortError') return;
  console.error(error);
  errorLine.textContent = error instanceof Error ? error.message : String(error);
};

/** The default world: a west coast, two river valleys and mountains high enough for snow, so every belt shows. */
const COAST = {
  climate: { latitude: 46, rainfall: 1100 },
  relief: { relief: 1600, base: 300, coast: 'west', rivers: 2 },
} as const satisfies { climate: ClimateOptions; relief: ReliefOptions };
type PresetKey = 'coast' | keyof typeof presetWorlds;
const startOf = (key: PresetKey): { climate: ClimateOptions; relief: ReliefOptions } =>
  key === 'coast' ? COAST : presetWorlds[key];

const settings = {
  preset: 'coast' as PresetKey,
  seed: 1,
  rivers: true,
  temperature: 0,
  rainfall: 1100,
  relief: 1600,
  trees: true,
  density: 1,
  stands: true,
};

function climate(): ClimateOptions {
  return {
    ...startOf(settings.preset).climate,
    rainfall: settings.rainfall,
    equatorTemperature: 27 + settings.temperature,
    poleTemperature: -20 + settings.temperature,
  };
}

function relief(): ReliefOptions {
  const start = startOf(settings.preset).relief;
  return { ...start, seed: settings.seed, relief: settings.relief, rivers: start.rivers || 2 };
}

/** The biomes of the chosen world, with the tree controls applied to every plant rule. */
function biomes(): BiomeDefinition[] {
  const base =
    settings.preset === 'island' ? presetWorlds.island.biomes : (Object.values(presets) as BiomeDefinition[]);
  if (settings.density === 1 && settings.stands) return [...base];
  return base.map((b) =>
    defineBiome({
      ...b,
      plants:
        settings.density === 0
          ? []
          : b.plants?.map(({ stands, ...plant }) => ({
              ...plant,
              density: plant.density * settings.density,
              ...(settings.stands && stands ? { stands } : {}),
            })),
    }),
  );
}

// The stage: WebGPU, a still afternoon sky, orbit controls that never dip under the ground.
const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  autoStart: false,
  label: 'A landscape whose ground, trees and snow follow its biome map',
  camera: { position: [-1700, 1500, 1300], target: [0, 350, 0], fov: 50, near: 1, far: 20000 },
  onError: report,
});
paceEngine(stage.engine);
const engine = stage.engine,
  canvas = stage.canvas;
const sky = Sky.attach(engine, { hours: 15.5, timeScale: 0, environment: true });
const controls = new OrbitControls(engine.camera, canvas);
controls.minDistance = 40;
controls.maxDistance = 6000;
controls.maxPolarAngle = Math.PI / 2 - 0.06;
controls.enableDamping = true;
controls.targetBounds = { min: [-2048, -500, -2048], max: [2048, 9000, 2048] };

const map = new WorldMap($<HTMLCanvasElement>('#map'), $('#legend'));
type World = { world: BiomeWorld; view: BiomeView; editor: BiomeEditor; abort: AbortController; off: () => void };
let current: World | undefined;
let started = false;

// Rebuilds are serialised; a change that arrives during one runs one more build after it, with every newer setting.
let building = false,
  again = false;
async function rebuild(keepPaint = true): Promise<void> {
  if (building) {
    again = true;
    return;
  }
  building = true;
  try {
    do {
      again = false;
      await build(keepPaint);
    } while (again);
  } catch (error) {
    report(error);
  } finally {
    building = false;
  }
}

async function build(keepPaint: boolean): Promise<void> {
  const edits = keepPaint && current ? [...current.editor.edits] : [];
  teardown();
  errorLine.textContent = '';
  say('Growing the landscape.');
  const abort = new AbortController(),
    since = performance.now(),
    world = await BiomeWorld.create({
      seed: settings.seed,
      climate: climate(),
      height: { relief: relief() },
      biomes: biomes(),
      signal: abort.signal,
    });
  const editor = BiomeEditor.attach(world);
  if (edits.length) editor.stroke(() => edits.forEach((edit) => editor.apply(edit)));
  let view: BiomeView;
  try {
    view = await BiomeView.attach(engine, world, {
      sky,
      objects: settings.trees,
      water: settings.rivers ? { rivers: 'auto' } : 'auto',
      signal: abort.signal,
    });
  } catch (error) {
    editor.dispose();
    world.dispose();
    throw error;
  }
  let pending: ReturnType<typeof setTimeout> | undefined;
  const off = world.onChange(() => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      void map.sample(world);
      void timeTile();
    }, 250);
  });
  current = { world, view, editor, abort, off: () => (off(), clearTimeout(pending)) };
  ground();
  fillBrushBiomes(world);
  refreshHistory();
  if (!started) {
    started = true;
    engine.start();
  }
  void map.sample(world);
  await view.ready;
  if (current?.world !== world) return;
  say(`Ready in ${Math.round(performance.now() - since).toLocaleString('en')} ms. Drag to look around.`);
  void timeTile();
}

function teardown(): void {
  if (!current) return;
  const { world, view, editor, abort, off } = current;
  current = undefined;
  off();
  abort.abort();
  view.dispose();
  editor.dispose();
  world.dispose();
}

/** Puts the orbit target back on the ground (a new seed moves the hills under it). */
function ground(): void {
  if (!current) return;
  const [x, y, z] = controls.target,
    h = current.world.heightAt(x, z),
    p = engine.camera.position;
  controls.target = [x, h, z];
  engine.camera.position = [p[0], p[1] + h - y, p[2]];
}

// Climate and tree settings change the world in place; the view and the map redraw what the change reaches.
function update(changes: Parameters<BiomeWorld['update']>[0]): void {
  if (building) {
    again = true;
    return;
  }
  if (!current) return;
  try {
    current.world.update(changes);
  } catch (error) {
    report(error);
  }
}

// Controls.
const formats: Record<string, (v: number) => string> = {
  temperature: (v) => `${v > 0 ? '+' : ''}${v} C`,
  rainfall: (v) => `${v.toLocaleString('en')} mm`,
  relief: (v) => `${v.toLocaleString('en')} m`,
  density: (v) => `${v} %`,
  'brush-size': (v) => `${v} m`,
};
const showValue = (id: string) => {
  $(`#${id}-value`).textContent = formats[id](Number(input(id).value));
};
for (const id of Object.keys(formats)) input(id).addEventListener('input', () => showValue(id));

input('temperature').addEventListener('change', () => {
  settings.temperature = Number(input('temperature').value);
  update({ climate: climate() });
});
input('rainfall').addEventListener('change', () => {
  settings.rainfall = Number(input('rainfall').value);
  update({ climate: climate() });
});
input('relief').addEventListener('change', () => {
  settings.relief = Number(input('relief').value);
  void rebuild();
});
$<HTMLSelectElement>('#preset').addEventListener('change', (event) => {
  settings.preset = (event.target as HTMLSelectElement).value as PresetKey;
  const start = startOf(settings.preset);
  settings.temperature = 0;
  settings.rainfall = start.climate.rainfall ?? 900;
  settings.relief = start.relief.relief ?? 900;
  input('temperature').value = '0';
  input('rainfall').value = String(settings.rainfall);
  input('relief').value = String(settings.relief);
  for (const id of ['temperature', 'rainfall', 'relief']) showValue(id);
  void rebuild(false);
});
const seedInput = input('seed');
const setSeed = (seed: number) => {
  settings.seed = Math.min(Math.max(Math.floor(seed) || 1, 1), 4294967295);
  seedInput.value = String(settings.seed);
  void rebuild();
};
seedInput.addEventListener('change', () => setSeed(Number(seedInput.value)));
$('#roll').addEventListener('click', () => setSeed(1 + Math.floor(Math.random() * 4294967294)));
input('rivers').addEventListener('change', () => {
  settings.rivers = input('rivers').checked;
  void rebuild();
});
input('trees').addEventListener('change', () => {
  settings.trees = input('trees').checked;
  void rebuild();
});
input('density').addEventListener('change', () => {
  settings.density = Number(input('density').value) / 100;
  update({ biomes: biomes() });
});
input('stands').addEventListener('change', () => {
  settings.stands = input('stands').checked;
  update({ biomes: biomes() });
});
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=layer]'))
  radio.addEventListener('change', () => {
    if (radio.checked) map.layer = radio.value as MapLayer;
  });

// Painting: Paint and Erase are toggles; with one on, a drag on the land or on the map paints instead of moving.
type Tool = 'none' | 'paint' | 'erase';
let tool: Tool = 'none';
const brushBiome = $<HTMLSelectElement>('#brush-biome');
function fillBrushBiomes(world: BiomeWorld): void {
  const chosen = brushBiome.value || 'desert';
  brushBiome.replaceChildren(...world.biomes.map((b) => new Option(pretty(b.id), b.id)));
  brushBiome.value = world.biomes.some((b) => b.id === chosen) ? chosen : world.biomes[0].id;
}
function setTool(next: Tool): void {
  tool = tool === next ? 'none' : next;
  $('#paint').setAttribute('aria-pressed', String(tool === 'paint'));
  $('#erase').setAttribute('aria-pressed', String(tool === 'erase'));
  controls.enabled = tool === 'none';
}
$('#paint').addEventListener('click', () => setTool('paint'));
$('#erase').addEventListener('click', () => setTool('erase'));
function refreshHistory(): void {
  const editor = current?.editor;
  $<HTMLButtonElement>('#undo').disabled = !editor?.canUndo;
  $<HTMLButtonElement>('#redo').disabled = !editor?.canRedo;
  $<HTMLButtonElement>('#clear').disabled = !editor?.edits.length;
}
$('#undo').addEventListener('click', () => {
  current?.editor.undo();
  refreshHistory();
});
$('#redo').addEventListener('click', () => {
  current?.editor.redo();
  refreshHistory();
});
$('#clear').addEventListener('click', () => void rebuild(false));

let stroke: { end(): void } | undefined, lastDab: [number, number] | undefined;
function dab(x: number, z: number): void {
  const editor = current?.editor,
    world = current?.world;
  if (!editor || !world) return;
  const radius = Number(input('brush-size').value),
    [x0, z0, x1, z1] = world.bounds;
  if (x < x0 || x > x1 || z < z0 || z > z1) return;
  if (lastDab && Math.hypot(x - lastDab[0], z - lastDab[1]) < radius * 0.3) return;
  lastDab = [x, z];
  if (tool === 'paint') editor.paint(brushBiome.value, { center: [x, z], radius, strength: 0.6 });
  else for (const layer of new Set(editor.edits.map((e) => e.layer))) editor.erase(layer, { center: [x, z], radius });
}
function beginStroke(at: [number, number] | undefined): void {
  if (!current || !at) return;
  stroke = current.editor.stroke();
  lastDab = undefined;
  dab(at[0], at[1]);
}
function endStroke(): void {
  stroke?.end();
  stroke = undefined;
  refreshHistory();
}

/** The ground point under a pointer on the terrain: a march along the camera ray against world.heightAt. */
function pick(event: PointerEvent): [number, number] | undefined {
  const world = current?.world;
  if (!world) return undefined;
  const r = canvas.getBoundingClientRect(),
    cam = engine.camera,
    nx = ((event.clientX - r.left) / r.width) * 2 - 1,
    ny = 1 - ((event.clientY - r.top) / r.height) * 2,
    o = cam.position,
    f = norm(sub(cam.target, o)),
    right = norm(cross(f, cam.up)),
    up = cross(right, f),
    t = Math.tan((cam.fov * Math.PI) / 360),
    aspect = r.width / Math.max(r.height, 1),
    d = norm([
      f[0] + (right[0] * nx * aspect + up[0] * ny) * t,
      f[1] + (right[1] * nx * aspect + up[1] * ny) * t,
      f[2] + (right[2] * nx * aspect + up[2] * ny) * t,
    ]);
  const above = (s: number) => o[1] + d[1] * s - world.heightAt(o[0] + d[0] * s, o[2] + d[2] * s);
  let s0 = 0;
  for (let s = 8; s < 12000; s += 8) {
    if (above(s) < 0) {
      let a = s0,
        b = s;
      for (let i = 0; i < 14; i++) {
        const m = (a + b) / 2;
        if (above(m) < 0) b = m;
        else a = m;
      }
      return [o[0] + d[0] * b, o[2] + d[2] * b];
    }
    s0 = s;
  }
  return undefined;
}
type V = readonly [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

let probed: BiomeSample | undefined;
function probe(at: [number, number] | undefined): void {
  if (!current || !at) return;
  probed = current.world.sample(at[0], at[1], probed);
  probeLine.textContent = describe(current.world, probed, at[0], at[1]);
}

// Pointer input on the terrain: painting with a tool on, a tap (no drag) reads the climate there.
let down: { x: number; y: number } | undefined,
  lastProbe = 0;
canvas.addEventListener('pointerdown', (event) => {
  down = { x: event.clientX, y: event.clientY };
  if (tool === 'none') return;
  canvas.setPointerCapture(event.pointerId);
  beginStroke(pick(event));
});
canvas.addEventListener('pointermove', (event) => {
  if (stroke) {
    const at = pick(event);
    if (at) dab(at[0], at[1]);
  } else if (event.pointerType === 'mouse' && !event.buttons && performance.now() - lastProbe > 120) {
    lastProbe = performance.now();
    probe(pick(event));
  }
});
const release = (event: PointerEvent) => {
  if (stroke) endStroke();
  else if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 6) probe(pick(event));
  down = undefined;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', () => {
  endStroke();
  down = undefined;
});

// Pointer input on the map: painting with a tool on; otherwise a tap reads the climate and moves the view there.
const mapCanvas = map.canvas;
mapCanvas.addEventListener('pointerdown', (event) => {
  mapCanvas.setPointerCapture(event.pointerId);
  const at = map.toWorld(event);
  if (tool !== 'none') return beginStroke(at);
  if (!at || !current) return;
  probe(at);
  const [tx, ty, tz] = controls.target,
    h = current.world.heightAt(at[0], at[1]),
    p = engine.camera.position;
  controls.target = [at[0], h, at[1]];
  engine.camera.position = [p[0] + at[0] - tx, p[1] + h - ty, p[2] + at[1] - tz];
});
mapCanvas.addEventListener('pointermove', (event) => {
  const at = map.toWorld(event);
  if (stroke && at) dab(at[0], at[1]);
});
mapCanvas.addEventListener('pointerup', () => stroke && endStroke());
mapCanvas.addEventListener('pointercancel', () => stroke && endStroke());

// Tile time: one tile at the middle of the view, timed whenever the world changes or the view moves to a new tile.
let tileMs: number | undefined,
  timedKey = '';
async function timeTile(): Promise<void> {
  const world = current?.world;
  if (!world) return;
  const [x, , z] = controls.target,
    tx = Math.min(Math.max(Math.floor((x - world.bounds[0]) / world.tileSize), 0), world.tilesX - 1),
    tz = Math.min(Math.max(Math.floor((z - world.bounds[1]) / world.tileSize), 0), world.tilesZ - 1),
    since = performance.now();
  timedKey = `${tx},${tz}`;
  try {
    await world.tile(tx, tz, { signal: current?.abort.signal });
    tileMs = performance.now() - since;
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError' && current?.world === world) report(error);
  }
}
function showTiming(): void {
  const world = current?.world,
    view = current?.view;
  if (!world || !view) return;
  const workers = world.workers?.size ?? 0,
    copies = [...view.tileTimes].sort((a, b) => a - b),
    median = copies.length ? copies[copies.length >> 1] : undefined,
    where = workers ? `on a worker (${workers} running)` : 'on this thread';
  timingLine.textContent =
    (tileMs === undefined
      ? 'Timing the first tile.'
      : `One ${world.tileSize} m tile, all ${((world.tileSize / world.resolution) ** 2).toLocaleString('en')} cells: ${tileMs.toFixed(0)} ms ${where}.`) +
    (median === undefined ? '' : ` Copying a tile in: ${median.toFixed(2)} ms.`) +
    ` Tiles on the way: ${view.streaming.pending}.`;
}

// Twice a second (a timer, so it also runs while frames are paused): the timing line, and a new tile time once the
// middle of the view crosses into another tile.
const timer = setInterval(() => {
  const world = current?.world;
  if (!world) return;
  showTiming();
  const t = controls.target,
    key = `${Math.floor((t[0] - world.bounds[0]) / world.tileSize)},${Math.floor((t[2] - world.bounds[1]) / world.tileSize)}`;
  if (key !== timedKey && !building) void timeTile();
}, 500);

// Each frame: keep the camera above the ground and move the map's pointer.
stage.use({
  name: 'biomes-demo',
  setup() {},
  onPreUpdate() {
    const world = current?.world;
    if (!world) return;
    const p = engine.camera.position,
      floor = world.heightAt(p[0], p[2]) + 12;
    if (p[1] < floor) engine.camera.position = [p[0], floor, p[2]];
    const t = controls.target;
    map.mark(t[0], t[2], Math.atan2(t[0] - p[0], p[2] - t[2]));
  },
  dispose: () => {
    clearInterval(timer);
    controls.dispose();
    teardown();
  },
});

// Files: the 1 km square (4 x 4 tiles) around the middle of the view, through @margoengine/biomes/io.
function exportTiles(world: BiomeWorld): [number, number, number, number] {
  const [x, , z] = controls.target,
    span = Math.max(1, Math.round(1024 / world.tileSize)),
    cx = Math.floor((x - world.bounds[0]) / world.tileSize - span / 2 + 0.5),
    cz = Math.floor((z - world.bounds[1]) / world.tileSize - span / 2 + 0.5),
    x0 = Math.min(Math.max(cx, 0), world.tilesX - span),
    z0 = Math.min(Math.max(cz, 0), world.tilesZ - span);
  return [
    Math.max(x0, 0),
    Math.max(z0, 0),
    Math.min(x0 + span, world.tilesX) - 1,
    Math.min(z0 + span, world.tilesZ) - 1,
  ];
}
const fileButtons = ['#export-height', '#export-masks', '#export-world'].map((s) => $<HTMLButtonElement>(s));
async function exporting(work: (world: BiomeWorld, io: typeof import('@margoengine/biomes/io')) => Promise<string>) {
  const world = current?.world;
  if (!world) return;
  for (const b of fileButtons) b.disabled = true;
  say('Making the files.');
  try {
    const io = await import('@margoengine/biomes/io');
    say(await work(world, io));
  } catch (error) {
    report(error);
  } finally {
    for (const b of fileButtons) b.disabled = false;
  }
}
const base = () => `biomes-${settings.preset}-seed${settings.seed}`;
fileButtons[0].addEventListener('click', () =>
  exporting(async (world, io) => {
    const height = await io.exportHeight(world, 'png16', { tiles: exportTiles(world), compress: true });
    download(`${base()}-height.png`, height.data, 'image/png');
    return `Saved a ${height.width} by ${height.depth} height PNG at ${height.resolution} m cells: black is ${height.min.toFixed(1)} m, white ${height.max.toFixed(1)} m.`;
  }),
);
fileButtons[1].addEventListener('click', () =>
  exporting(async (world, io) => {
    const tiles = exportTiles(world),
      masks = await io.exportMasks(world, { tiles, compress: true }),
      about =
        `Biome masks from Margo Engine, ${settings.preset} world, seed ${settings.seed}.\n` +
        `One 8-bit grayscale PNG per biome, white = full weight, at ${world.resolution} m cells.\n` +
        `Tiles ${tiles.join(', ')} (x0, z0, x1, z1) of ${world.tileSize} m; north (-z) is the top row.\n`;
    download(
      `${base()}-masks.tar`,
      tar([
        ['about.txt', new TextEncoder().encode(about)],
        ...[...masks].map(([id, png]) => [`${id}.png`, png] as const),
      ]),
      'application/x-tar',
    );
    return `Saved ${masks.size} biome masks in one .tar archive.`;
  }),
);
fileButtons[2].addEventListener('click', () =>
  exporting(async (world, io) => {
    download(`${base()}.json`, JSON.stringify(io.saveWorld(world)), 'application/json');
    return 'Saved the world file: its settings and every painted layer. loadWorld() opens it again.';
  }),
);

window.addEventListener('pagehide', () => stage.dispose(), { once: true });
await rebuild();
