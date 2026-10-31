// Margo voxel sandbox: a small block-world game on @margoengine/voxel. Streamed noise terrain with plants, sky and
// block light, a first-person body that walks, sprints, jumps, swims and flies, block breaking and placing with an
// outline, a hotbar, and saves in IndexedDB. `?view=<name>` is the deterministic mode for screenshots and benchmarks
// (fixed seed, camera, time; no input; `window.voxelSandbox` reports readiness and stats). `?server=ws://host:port` joins a
// multiplayer server (server.mjs, multiplayer.ts) instead of streaming the world here; `?plaza=https://host` (or a page
// under /plaza/) asks that router's /join where to play. Every way a join can fail ends in this same sandbox, playing
// alone, with a banner. README.md lists the controls and URL parameters.
import { Engine, type EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Line, Lines } from '@margoengine/lines';
import { applyQualityTier, paceEngine, watchQuality } from '@margoengine/quality';
import {
  blockId,
  connectStairs,
  doubleSlabState,
  slabState,
  stairState,
  type VoxelChunk,
  VoxelWorld,
  waterlogState,
} from '@margoengine/voxel';
import { VoxelLighting } from '@margoengine/voxel/light';
import { raycastVoxels, VoxelCharacter, type VoxelHit } from '@margoengine/voxel/query';
import { BlockTextures, VoxelRenderer } from '@margoengine/voxel/render';
import { IndexedDBChunkStore, MemoryChunkStore, VoxelStreamer } from '@margoengine/voxel/stream';
import { BLOCK_DEFINITIONS, defineBlocks, HOTBAR } from './blocks.ts';
import generatorUrl from './generator.worker.ts?worker&url';
import { type SceneLighting, setupLighting } from './lighting.ts';
import type { Figures } from './figures.ts';
import {
  closeKind,
  EditWatch,
  IDLE_BANNER,
  joinPlaza,
  joinServer,
  keyBits,
  NOTICE_EVERY,
  type Online,
  PROTECTED_MESSAGE,
  plazaName,
  REFUSED_MESSAGE,
  REPORT_EVERY,
  sendReport,
  soloBanner,
} from './multiplayer.ts';
import type { PhotoMode } from './photo.ts';
import { isPlazaProtected } from './plaza-area.ts';
import { buildShapes, buildShowcase, groundY, showcaseReady } from './showcase.ts';
import { DEFAULT_SEED } from './terrain.ts';
import { paintBlockTextures } from './textures.ts';
import { slotsThatFit, TouchControls } from './touch.ts';
import {
  eggCounter,
  Hotbar,
  setBanner,
  setDeterministic,
  setHud,
  setOverlay,
  setReport,
  setTouchUi,
  setUnderwater,
  showError,
  toast,
  toggleHud,
} from './ui.ts';
import './style.css';

type Vec3 = [number, number, number];
declare const GPUBufferUsage: { QUERY_RESOLVE: number; COPY_SRC: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** A fixed camera pose of the deterministic mode. */
interface View {
  eye: Vec3;
  /** Radians; 0 looks along -z, positive turns left (towards -x). */
  yaw: number;
  /** Radians; positive looks up. */
  pitch: number;
  /** Clock hours. */
  hours: number;
  /** South-west corner column of the showcase hut, or none. */
  showcase?: [number, number];
  /** What the showcase builds: the hut (default) or the slab and stair yard. */
  build?: 'hut' | 'shapes';
}
// The deterministic views (seed 1): a vista over hills and a lake at 10:00; the showcase hut by the lake at eye height
// at 10:00 and at 21:30 (torch and glowstone light); slabs and stairs in its place at 10:00, sun-shadowed.
const VIEWS: Record<string, View> = {
  overview: { eye: [-60, 42, 70], yaw: 2.6, pitch: -0.2, hours: 10, showcase: [-27, 16] },
  ground: { eye: [-17.5, 0, 31.5], yaw: 0.48, pitch: -0.1, hours: 10, showcase: [-27, 16] },
  night: { eye: [-17.5, 0, 31.5], yaw: 0.48, pitch: -0.1, hours: 21.5, showcase: [-27, 16] },
  shapes: { eye: [-17, 21.5, 28], yaw: 0.68, pitch: -0.5, hours: 10, showcase: [-27, 16], build: 'shapes' },
};

const params = new URLSearchParams(location.search),
  integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(params.get(name));
    return params.has(name) && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
  },
  viewName = params.get('view'),
  // ?pose=x,y,z,yaw,pitch replaces the view's camera (y 0: eye height over the ground).
  pose = params.get('pose')?.split(',').map(Number),
  view: View | undefined =
    viewName && VIEWS[viewName]
      ? pose?.length === 5 && pose.every(Number.isFinite)
        ? { ...VIEWS[viewName], eye: [pose[0], pose[1], pose[2]], yaw: pose[3], pitch: pose[4] }
        : { ...VIEWS[viewName] }
      : undefined,
  deterministic = viewName !== null,
  // A multiplayer server to join (not in the deterministic mode).
  serverUrl = viewName === null ? params.get('server') : null,
  // The Plaza router that answers /join (not with a direct ?server=).
  routerUrl =
    viewName === null && !serverUrl
      ? (params.get('plaza') ?? (location.pathname.startsWith('/plaza/') ? 'https://plaza.margoengine.com' : null))
      : null,
  JOIN_TIMEOUT = 5000, // milliseconds from the page's start to the server's welcome, else it plays alone
  RETRY = integer('retry', 30_000, 100, 600_000), // milliseconds between asks of the router while playing alone
  seed = integer('seed', DEFAULT_SEED, -(2 ** 31), 2 ** 31 - 1),
  DISTANCES = [4, 8, 12, 16],
  VERTICAL = 3, // chunks loaded above and below the camera's chunk
  EYE = 1.62, // eye height above the feet
  REACH = 6, // blocks
  REPEAT = 0.22, // seconds between repeated breaks or places while a button is held
  DAY = 24 / 1200; // clock hours per second: a day takes 20 minutes
let distance = integer('rd', 8, 2, 32);
const hours = params.has('time') ? Number(params.get('time')) : (view?.hours ?? 10);
// Before the engine exists: core reads the tier when it builds pipelines and sizes the canvas (?quality=high|low).
const tier = applyQualityTier(),
  // A phone playing, not a deterministic view with the phone tier forced: those views keep their references.
  phone = tier === 'phone' && !deterministic;
if (phone && !params.has('rd')) distance = 4;
const canvas = document.getElementById('scene') as HTMLCanvasElement;

/** What `window.voxelSandbox` exposes (screenshots, benchmarks, tests and the browser console). */
interface Sandbox {
  /** Every chunk in range is loaded, lit, meshed and uploaded (see `track`). */
  ready: boolean;
  /** The player stands in the world (normal mode). */
  readonly spawned: boolean;
  world: VoxelWorld;
  readonly player: VoxelCharacter;
  /** The local streamer; undefined when playing on a server (`online`). */
  readonly streamer: VoxelStreamer | undefined;
  /** The joined server (`?server=`, `?plaza=`); undefined when playing alone. */
  readonly online: Online | undefined;
  /** The seed and floor of the Plaza world the router sent the page to; undefined alone or on a direct `?server=`. */
  readonly plazaWorld: { seed: number; floor: number } | undefined;
  /** Asks the server for an edit the way a click does (the protected square refused here, edits watched); false when not sent. Online only. */
  edit(x: number, y: number, z: number, state: number): boolean;
  /** The other players' figures while online. */
  readonly figures: Figures | undefined;
  /** The touch controls; undefined in the deterministic mode. */
  readonly touch: TouchControls | undefined;
  voxels: VoxelRenderer;
  /** Where the player looks, radians. */
  readonly look: { yaw: number; pitch: number };
  /** The light: sky, shadows, local lights (lighting.ts). */
  scene: SceneLighting;
  /** The path-traced photo mode once it has loaded (photo.ts, a dynamic import; P toggles it). */
  readonly photo: PhotoMode | undefined;
  /** Loads the photo mode. */
  loadPhoto(): Promise<PhotoMode>;
  /** The block under the crosshair. */
  readonly target: VoxelHit | null;
  /** Milliseconds from the streamer's start: first voxel draw, every chunk in range loaded, ready (see README). */
  timeline: { startedAt: number; firstDraw?: number; loaded?: number; spawn?: number };
  stats(): Record<string, number | string | boolean>;
  frames(count: number): Promise<number[]>;
  /** Frame CPU milliseconds (update + render) of every frame from the streamer's start until ready. */
  fillFrames: number[];
  fly(count: number, speed: number): Promise<{ cpu: number[]; stats: Record<string, number | string | boolean> }>;
  gpuTiming(count: number): Promise<number[] | null>;
}

async function boot(): Promise<void> {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable: open the sandbox in a browser with WebGPU');
  if (viewName !== null && !view) throw new RangeError(`No view "${viewName}"; use ${Object.keys(VIEWS).join(', ')}`);
  if (params.has('reset')) await resetSave();
  let features: GPUFeatureName[] = [];
  if (params.has('gpuTiming')) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter?.features.has('timestamp-query')) features = ['timestamp-query'];
  }
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    features,
    camera: { position: [0.5, 40, 0.5], target: [0.5, 40, -1], near: 0.05, far: farFor(distance), fov: 70 },
  });
  const runtime = engineRuntime(engine);
  if (!deterministic) paceEngine(engine);
  let running = true;
  engine.onError = (error) => {
    running = false;
    showError(error);
  };
  runtime.gpu!.addEventListener('uncapturederror', (event) => engine.onError((event as GPUUncapturedErrorEvent).error));

  // World, light, renderer.
  const { blocks, labels } = defineBlocks(),
    world = new VoxelWorld({ blocks }),
    images = paintBlockTextures(),
    // Raw pixels need no canvas; ImageData objects only because BlockTexturesOptions.images is typed that way.
    textures = new BlockTextures({
      images: images.map((p) => new ImageData(new Uint8ClampedArray(p.data), p.width, p.height)),
    }),
    lighting = VoxelLighting.attach(world, { budget: Infinity }),
    workers = integer('workers', 0, 0, 8),
    voxels = VoxelRenderer.attach(engine, { world, textures, ...(workers ? { workers } : {}) }),
    scene: SceneLighting = setupLighting(engine, voxels, {
      hours,
      timeScale: deterministic ? 0 : DAY,
      distance: distance * 32,
      lightBlocks: blocks.table.flatMap((type, id) => (type.light > 0 ? [id] : [])),
      shadows: !phone,
    }),
    lines = new Lines();
  engine.use(lines);
  const outline = lines.add(new Line({ mode: 'segments', positions: cellBox(0, 0, 0), color: '#000000', width: 2 }));
  outline.material.opacity = 0.55;
  outline.visible = false;

  // Streaming: the generator worker gets the seed in its URL; a deterministic view keeps nothing. On a server, the
  // server sends the chunks instead.
  const timeline: Sandbox['timeline'] = { startedAt: performance.now() },
    joining = !!(serverUrl || routerUrl),
    pending = () => streamer?.pending ?? (online?.client.loaded ? 0 : 1);
  let online: Online | undefined,
    figures: Figures | undefined,
    streamer: VoxelStreamer | undefined = joining ? undefined : startStreamer();
  function startStreamer(): VoxelStreamer {
    const store = deterministic ? new MemoryChunkStore() : openStore(),
      generator = new URL(generatorUrl, location.href);
    generator.searchParams.set('seed', String(seed));
    const s = VoxelStreamer.attach(engine, {
      world,
      generator,
      store,
      distance,
      verticalDistance: VERTICAL,
      chunksPerFrame: 32, // loading: settle faster; 8 once ready
      frameBudget: 2, // loading: join 2 ms of chunks a frame (rd 16 fills in half the time of 0.5 ms); 0.5 once ready
      memoryBudget: 512 << 20,
    });
    s.onError = (error) => {
      console.warn(error);
      toast(`A chunk failed to load or save: ${error instanceof Error ? error.message : String(error)}`);
    };
    return s;
  }
  // Light after the streamer each frame (plugins update in the order they were added), so a chunk that joins the world
  // is lit in the same frame and meshed once, with its light.
  let lightWork = 0;
  const lightPlugin = {
    name: 'voxel-sandbox:light',
    setup() {},
    onPreUpdate: () => {
      lightWork = lighting.update();
    },
  };
  engine.use(lightPlugin);
  const loaded = new Map<string, VoxelChunk>();
  world.onChunk((cx, cy, cz, chunk) => {
    if (chunk) loaded.set(`${cx},${cy},${cz}`, chunk);
    else loaded.delete(`${cx},${cy},${cz}`);
  });
  // Photo mode (P): the loaded world path-traced; `?photo` starts in it. A dynamic import, so the tracer is not part of
  // the first download. Phones are refused: the tracer needs a desktop GPU.
  let photo: PhotoMode | undefined, photoLoad: Promise<PhotoMode> | undefined;
  const loadPhoto = () =>
    (photoLoad ??= import('./photo.ts').then(({ PhotoMode }) => {
      photo = new PhotoMode(engine, {
        world,
        blocks,
        images,
        chunks: loaded,
        hours: () => scene.hours,
        distance: () => distance * 32,
      });
      return photo;
    }));
  const togglePhoto = async () => {
    if (phone) return toast('Photo mode needs a desktop GPU, so it stays off on phones');
    try {
      toast((await loadPhoto()).toggle() ? 'Photo mode: path traced (P leaves, Enter saves a PNG)' : 'Photo mode off');
    } catch (error) {
      photoLoad = undefined; // the next P tries the download again
      console.warn(error);
      toast('Photo mode could not load; check the connection and press P again');
    }
  };
  if (params.has('photo')) {
    if (phone) await togglePhoto();
    else (await loadPhoto()).toggle();
  }

  // Player, hotbar, saved state (none on a server: it places the player).
  let player = new VoxelCharacter(world);
  const labelOf = new Map(BLOCK_DEFINITIONS.map(([name], i) => [name, labels[i + 1]])),
    hotbar = new Hotbar(HOTBAR, (name) => {
      const type = blocks.get(blocks.id(name));
      return { label: labelOf.get(name) ?? name, pixels: images[type.textures[4]], cross: type.shape === 'cross' };
    });
  let yaw = 0,
    pitch = 0,
    flyWanted = false, // fly mode on a server: sent with each step
    spawned = false,
    showcase = view?.showcase ? 'waiting' : 'none';
  let saved: SavedPlayer | undefined;
  function restorePlayer(): void {
    saved = loadPlayer();
    if (!saved) return;
    player.position = [...saved.position];
    player.flying = saved.flying;
    yaw = saved.yaw;
    pitch = saved.pitch;
    saved.slots.forEach((name, i) => {
      if (blocksHas(name)) hotbar.slots[i] = name;
    });
    hotbar.select(saved.selected);
  }
  if (!deterministic && !joining) restorePlayer();
  function blocksHas(name: string): boolean {
    try {
      blocks.id(name);
      return true;
    } catch {
      return false;
    }
  }
  if (view) {
    yaw = view.yaw;
    pitch = view.pitch;
    setDeterministic();
  }
  const camera = engine.camera,
    forward = (): Vec3 => [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const aim = (eye: Vec3) => {
    const f = forward();
    camera.position = eye;
    camera.target = [eye[0] + f[0], eye[1] + f[1], eye[2] + f[2]];
  };
  // A view at y 0 stands on the ground (eye height above it) once that column is loaded; until then it waits above it.
  const viewEye = (v: View): Vec3 => {
    if (v.eye[1] !== 0) return v.eye;
    const ground = groundY(world, Math.floor(v.eye[0]), Math.floor(v.eye[2]));
    return [v.eye[0], ground === undefined ? 40 : ground + 1 + EYE, v.eye[2]];
  };
  if (view) aim(viewEye(view));
  else if (saved) aim([saved.position[0], saved.position[1] + EYE, saved.position[2]]);

  // Input: pointer lock, keys, buttons.
  const keys = new Set<string>(),
    noKeys: ReadonlySet<string> = new Set<string>(),
    buttons = new Set<number>();
  let repeat = 0,
    lastSpace = 0;
  // Read the lock itself, not a flag set by pointerlockchange (which arrives after pointerLockElement changes).
  const isLocked = () => document.pointerLockElement === canvas;
  // Playing: the pointer is locked, or on a touch screen the player tapped past the overlay.
  const isPlaying = () => isLocked() || !!touch?.active;
  let touch: TouchControls | undefined;
  const events = new AbortController(),
    on = <K extends keyof DocumentEventMap>(type: K, f: (e: DocumentEventMap[K]) => void) =>
      document.addEventListener(type, f, { signal: events.signal });
  if (!deterministic) {
    touch = new TouchControls(canvas, document.getElementById('hotbar')!, document.getElementById('touch-buttons')!, {
      look(dx, dy) {
        yaw -= dx * 0.005;
        pitch = Math.max(-1.55, Math.min(1.55, pitch - dy * 0.005));
      },
      place: () => act(2),
      break: () => act(0),
      fly: toggleFly,
      keys,
      slot: () => hotbar.selected,
      select: (slot) => hotbar.select(slot),
      slots: hotbar.slots.length,
    });
    // A coarse pointer starts with the touch screen's layout: buttons, a smaller hotbar, no HUD text. A touch on a
    // screen that also has a mouse switches to it when the player taps past the overlay.
    const touchLayout = () => {
      setTouchUi(true);
      toggleHud(false);
      const fit = () => {
        hotbar.fit = slotsThatFit(innerWidth);
        hotbar.refresh();
      };
      fit();
      addEventListener('resize', fit, { signal: events.signal });
    };
    if (matchMedia('(pointer: coarse)').matches) touchLayout();
    canvas.addEventListener('click', () => {
      if (!isPlaying() && spawned) void canvas.requestPointerLock?.();
    });
    const overlay = document.getElementById('overlay')!;
    overlay.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch' || !spawned || touch!.active) return;
      if (!document.body.classList.contains('touch')) touchLayout();
      touch!.active = true;
      setOverlay('playing');
      playing();
    });
    overlay.addEventListener('click', () => {
      if (spawned && !isPlaying()) void canvas.requestPointerLock?.();
    });
    on('pointerlockchange', () => {
      setOverlay(isLocked() ? 'playing' : 'paused');
      if (isLocked()) return playing();
      keys.clear(); // keys released while unlocked never reach us
      buttons.clear();
      save();
    });
    on('mousemove', (e) => {
      if (!isLocked()) return;
      yaw -= e.movementX * 0.0024;
      pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * 0.0024));
    });
    on('mousedown', (e) => {
      if (!isLocked()) return;
      buttons.add(e.button);
      act(e.button);
      repeat = REPEAT * 1.5;
    });
    on('mouseup', (e) => buttons.delete(e.button));
    on('contextmenu', (e) => {
      if (isLocked()) e.preventDefault();
    });
    document.addEventListener(
      'wheel',
      (e) => {
        if (isLocked()) hotbar.select(hotbar.selected + Math.sign(e.deltaY));
      },
      { signal: events.signal, passive: true },
    );
    const eggPress = eggCounter(() => toast('Margo engine \u2764\uFE0F made for Margie'));
    on('keydown', (e) => {
      if (e.code === 'KeyM' && !e.repeat) eggPress();
      if (e.code === 'F3') e.preventDefault();
      if (!isPlaying() && e.code !== 'F3') return;
      keys.add(e.code);
      if (e.repeat) return;
      if (/^Digit[1-9]$/.test(e.code)) hotbar.select(Number(e.code.slice(5)) - 1);
      else if (e.code === 'KeyF') toggleFly();
      else if (e.code === 'Space') {
        const now = performance.now();
        if (now - lastSpace < 300) toggleFly();
        lastSpace = now;
      } else if (e.code === 'KeyV') {
        setDistance(DISTANCES[(DISTANCES.indexOf(distance) + 1) % DISTANCES.length]);
        toast(`Render distance ${distance} chunks (${distance * 32} blocks)`);
      } else if (e.code === 'KeyT') {
        scene.hours = (Math.floor(scene.hours / 3) * 3 + 3) % 24;
        toast(`Time ${String(Math.floor(scene.hours)).padStart(2, '0')}:00`);
      } else if (e.code === 'KeyH' || e.code === 'F3') toggleHud();
      else if (e.code === 'KeyP') void togglePhoto();
      else if (e.code === 'KeyR') report();
      else if (e.code === 'Enter' && photo?.on) {
        toast('Rendering a photo');
        photo.save(canvas.width, canvas.height).then(
          () => toast('Photo saved'),
          (error) => toast(`The photo failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    });
    on('keyup', (e) => keys.delete(e.code));
    on('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        save();
        if (touch?.active) keys.clear(); // fingers lifted while hidden never reach us
      }
    });
    addEventListener(
      'offline',
      () => {
        if (online) goSolo('offline');
      },
      { signal: events.signal },
    );
    addEventListener('pagehide', () => save(), { signal: events.signal });
    setInterval(() => save(), 15000);
  }
  function toggleFly(): boolean {
    if (online && !online.client.welcome?.flight) {
      toast('This server does not allow flying');
      return false;
    }
    const on = online ? (flyWanted = !flyWanted) : (player.flying = !player.flying);
    toast(on ? (touch?.active ? 'Flying' : 'Flying (Space up, Shift down)') : 'Walking');
    return on;
  }
  // A griefing report: where the player stands, on which shard. The router counts them; the page holds to its limit.
  function report(): void {
    if (!online || !routerUrl) return toast('Reports work when playing on Plaza');
    const now = performance.now();
    if (now - lastReport < REPORT_EVERY) return toast('One report a minute');
    lastReport = now;
    const [x, , z] = player.position;
    sendReport(routerUrl, { shard, x, z }).then(
      () => toast('Report sent. Thank you.'),
      (error) => {
        console.warn(error);
        toast('The report did not reach Plaza');
      },
    );
  }
  function setDistance(chunks: number): void {
    if (!streamer) return toast('On a server the render distance is set when joining (?rd=)');
    distance = chunks;
    streamer.distance = chunks;
    camera.far = farFor(chunks);
    scene.setDistance(chunks * 32);
  }

  // Break (left), place (right), pick block (middle) at the block under the crosshair.
  let hit: VoxelHit | null = null,
    outlined = '';
  // A line for the player, at most once every NOTICE_EVERY: a held button asks again every REPEAT seconds.
  function notice(text: string): void {
    const now = performance.now();
    if (now - lastNotice < NOTICE_EVERY) return;
    lastNotice = now;
    toast(text);
  }
  // Asks the server for an edit unless the shard's own rule (isPlazaProtected, the same function) would refuse it:
  // then nothing changes on screen and the player is told why. Returns whether it was sent.
  function sendEdit(x: number, y: number, z: number, state: number): boolean {
    if (!online) return false;
    if (worldInfo && isPlazaProtected(x, y, z, worldInfo.floor)) {
      notice(PROTECTED_MESSAGE);
      return false;
    }
    if (!online.client.edit(x, y, z, state)) return false;
    edits.add(x, y, z, state, performance.now());
    return true;
  }
  function act(button: number): void {
    if (!hit || !spawned) return;
    if (button === 0) {
      const [x, y, z] = hit.cell,
        above = blocks.get(blockId(world.getBlock(x, y + 1, z)));
      if (!online) {
        world.setBlocks(above.shape === 'cross' ? [x, y, z, 0, x, y + 1, z, 0] : [x, y, z, 0]);
        connectStairs(world, x, y, z);
      } else if (sendEdit(x, y, z, 0) && above.shape === 'cross') sendEdit(x, y + 1, z, 0);
    } else if (button === 2) {
      const id = blocks.id(hotbar.block),
        type = blocks.get(id),
        // A slab placed on the open half of the same slab makes a double slab in its cell.
        onSlab =
          type.shape === 'slab' &&
          hit.state === slabState(id, hit.normal[1] < 0) &&
          hit.normal[1] !== 0 &&
          hit.point[1] - Math.floor(hit.point[1]) === 0.5,
        [x, y, z] = onSlab ? hit.cell : hit.adjacent,
        there = blocks.get(blockId(world.getBlock(x, y, z))),
        below = blocks.get(blockId(world.getBlock(x, y - 1, z)));
      if (onSlab) {
        if (online) sendEdit(x, y, z, doubleSlabState(id));
        else world.setBlock(x, y, z, doubleSlabState(id));
        return;
      }
      if (there.id && !there.liquid && there.name !== 'tall_grass') return;
      if (type.solid && touchesPlayer(x, y, z)) return;
      if (type.shape === 'cross' && type.name !== 'torch' && !(below.solid && below.shape === 'cube')) return;
      // Slabs and stairs: the upper half when placed against a ceiling or the upper half of a side; a stair's back away
      // from the player, so it climbs the way they look.
      const f = forward(),
        high = hit.normal[1] < 0 || (hit.normal[1] === 0 && hit.point[1] - Math.floor(hit.point[1]) > 0.5),
        facing = Math.abs(f[0]) > Math.abs(f[2]) ? (f[0] > 0 ? '+x' : '-x') : f[2] > 0 ? '+z' : '-z',
        shaped =
          type.shape === 'slab' ? slabState(id, high) : type.shape === 'stair' ? stairState(id, facing, high) : id,
        // Placed into its waterlog liquid, a slab or stair is waterlogged.
        state = there.liquid && type.waterlog === there.id ? waterlogState(shaped) : shaped;
      if (online) sendEdit(x, y, z, state);
      else {
        world.setBlock(x, y, z, state);
        connectStairs(world, x, y, z);
      }
    } else if (button === 1) {
      const type = blocks.get(blockId(hit.state));
      hotbar.pick(type.name);
    }
  }
  function touchesPlayer(x: number, y: number, z: number): boolean {
    const [px, py, pz] = player.position,
      [w, h, d] = player.size;
    return x < px + w / 2 && x + 1 > px - w / 2 && y < py + h && y + 1 > py && z < pz + d / 2 && z + 1 > pz - d / 2;
  }

  let solo = false,
    idled = false,
    welcomeTimer: ReturnType<typeof setTimeout> | undefined,
    shard: number | undefined,
    worldId: string | undefined,
    // The seed and floor of the world the router sent us to; unknown on a direct ?server= (the welcome has neither).
    worldInfo: { seed: number; floor: number } | undefined,
    lastReport = Number.NEGATIVE_INFINITY,
    lastNotice = Number.NEGATIVE_INFINITY;
  const edits = new EditWatch();
  const serverName = serverUrl ?? 'Plaza';

  // Spawn: a saved position, else the first dry ground in a spiral around the origin, once that ground is loaded and lit.
  function trySpawn(): void {
    if (spawned || lightWork) return;
    if (online) {
      if (online.client.spawned) {
        spawned = true;
        setOverlay(isPlaying() ? 'playing' : 'paused');
      }
      return;
    }
    if (!streamer) return; // still asking the router
    if (saved) {
      const [x, y, z] = saved.position;
      if (world.getChunk(Math.floor(x) >> 5, Math.floor(y) >> 5, Math.floor(z) >> 5)) spawned = true;
    } else
      for (let r = 0; r <= 32 && !spawned; r += 2)
        for (let dz = -r; dz <= r && !spawned; dz += 2)
          for (let dx = -r; dx <= r; dx += 2) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const y = groundY(world, dx, dz, 120, -32);
            if (y === undefined) return; // not loaded yet
            const top = blocks.get(blockId(world.getBlock(dx, y, dz)));
            if ((top.name === 'grass' || top.name === 'sand') && !world.getBlock(dx, y + 1, dz)) {
              player.position = [dx + 0.5, y + 1, dz + 0.5];
              spawned = true;
              break;
            }
          }
    if (!spawned) return;
    setOverlay(isPlaying() ? 'playing' : 'paused');
  }

  // Each frame before rendering: player, camera, target block, deterministic build.
  let flight: { left: number; speed: number; cpu: number[]; done: () => void } | undefined;
  function update(dt: number): void {
    if (view) {
      if (showcase === 'waiting' && view.showcase && showcaseReady(world, ...view.showcase) && !lightWork) {
        (view.build === 'shapes' ? buildShapes : buildShowcase)(world, blocks, ...view.showcase);
        showcase = 'built';
      }
      if (flight) {
        const f = forward(),
          step = flight.speed / 60;
        view.eye = [view.eye[0] + f[0] * step, view.eye[1], view.eye[2] + f[2] * step];
      }
      aim(viewEye(view));
      return;
    }
    trySpawn();
    if (!spawned) return;
    const [px, py, pz] = player.position,
      ready = (y: number) => world.getChunk(Math.floor(px) >> 5, Math.floor(y) >> 5, Math.floor(pz) >> 5);
    // Hold the body still while the ground under it is not loaded (fast flight, a far teleport).
    const frozen = !ready(py) || !ready(py - 2);
    if (touch?.active) {
      touch.update(performance.now());
      touch.setDownVisible(online ? flyWanted || player.inLiquid : player.flying || player.inLiquid);
    }
    if (online) online.client.update(dt, { keys: keyBits(isPlaying() ? keys : noKeys, flyWanted), yaw, pitch });
    else if (!frozen) {
      const move = isPlaying() ? axis('KeyD', 'ArrowRight') - axis('KeyA', 'ArrowLeft') : 0,
        ahead = isPlaying() ? axis('KeyW', 'ArrowUp') - axis('KeyS', 'ArrowDown') : 0,
        sin = Math.sin(yaw),
        cos = Math.cos(yaw),
        shift = keys.has('ShiftLeft') || keys.has('ShiftRight'),
        down = shift || keys.has('KeyC');
      player.update(dt, {
        direction: [-sin * ahead + cos * move, 0, -cos * ahead - sin * move],
        jump: keys.has('Space'),
        descend: (player.flying || player.inLiquid) && down,
        sprint: !player.flying && shift,
      });
    }
    const [x, y, z] = online ? online.client.renderPosition : frozen ? player.position : player.renderPosition,
      eye: Vec3 = [x, y + EYE, z];
    aim(eye);
    if (online && figures) figures.update(online.client.samplePlayers(), dt, eye);
    hit = raycastVoxels(world, eye, forward(), REACH);
    const target = hit ? `${hit.cell}|${hit.state}` : '';
    if (hit && target !== outlined) {
      const type = blocks.get(blockId(hit.state));
      outline.setPositions(cellBox(...hit.cell, type.shape === 'cross' ? 0.2 : 0));
    }
    outlined = target;
    outline.visible = !!hit && isPlaying();
    setUnderwater(!!blocks.get(blockId(world.getBlock(Math.floor(x), Math.floor(y + EYE), Math.floor(z)))).liquid);
    if (
      online &&
      edits.settle(performance.now(), (cx, cy, cz) =>
        world.getChunk(cx >> 5, cy >> 5, cz >> 5) ? world.getBlock(cx, cy, cz) : undefined,
      )
    )
      notice(REFUSED_MESSAGE);
    if (buttons.size && (repeat -= dt) <= 0) {
      repeat = REPEAT;
      for (const b of buttons) if (b !== 1) act(b);
    }
  }
  const axis = (a: string, b: string) => +(keys.has(a) || keys.has(b));

  // Readiness: every chunk in range loaded, light current, meshes uploaded (the renderer's stats unchanged for 30
  // frames while nothing is dirty). `spawn` is the time of the last change, not of the check.
  const fillFrames: number[] = [];
  let lastQuads = -1,
    lastChunks = -1,
    stable = 0,
    lastChange = 0,
    ready = false;
  function track(now: number): void {
    const s = voxels.stats,
      idle = pending() === 0 && !lightWork && !world.dirty.size && showcase !== 'waiting' && (spawned || !!view);
    if (timeline.firstDraw === undefined && s.draws > 0) timeline.firstDraw = now - timeline.startedAt;
    if (timeline.loaded === undefined && pending() === 0 && (spawned || view))
      timeline.loaded = now - timeline.startedAt;
    if (s.quads !== lastQuads || s.chunks !== lastChunks || !idle || !s.draws) {
      lastQuads = s.quads;
      lastChunks = s.chunks;
      lastChange = now;
      stable = 0;
    } else stable++;
    if (!ready && stable >= 30) {
      ready = true;
      timeline.spawn = lastChange - timeline.startedAt;
      sandbox.ready = true;
      playing();
    }
  }
  // Loading is over (everything in range drawn, or the player started playing): spread the work of new chunks over
  // frames. The light tier measures the GPU for the next load; the full tier's slow-frame reload is not wanted in a
  // game with unsaved edits, so it is not watched.
  let settled = false,
    watching = false;
  function playing(): void {
    if (settled) return;
    settled = true;
    if (streamer) {
      streamer.chunksPerFrame = 8;
      streamer.frameBudget = 0.5;
    }
    lighting.budget = 16384;
    if (!deterministic && tier === 'light' && !watching) {
      watching = true;
      watchQuality();
    }
  }

  // HUD, every 250 ms.
  let frames = 0,
    fps = 0,
    fpsSince = performance.now(),
    hudAt = 0;
  function hud(now: number): void {
    frames++;
    if (now - fpsSince >= 1000) {
      fps = (frames * 1000) / (now - fpsSince);
      frames = 0;
      fpsSince = now;
    }
    if (deterministic || now - hudAt < 250) return;
    hudAt = now;
    const s = voxels.stats,
      [x, y, z] = player.renderPosition,
      facing = ['N', 'W', 'S', 'E'][Math.round((((yaw % (2 * Math.PI)) + 2 * Math.PI) / (Math.PI / 2)) % 4) % 4],
      mode = player.flying ? 'flying' : player.inLiquid ? 'swimming' : player.onGround ? 'walking' : 'falling';
    setHud([
      `${fps.toFixed(0)} FPS  ${tier} tier`,
      `XYZ ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}  facing ${facing}  ${mode}`,
      `chunk ${Math.floor(x) >> 5} ${Math.floor(y) >> 5} ${Math.floor(z) >> 5}  render distance ${distance}`,
      `chunks ${s.chunks} drawn, ${s.visible} visible, ${loaded.size} loaded, ${streamer ? `${streamer.pending} to load` : online?.client.loaded ? 'all received' : 'receiving'}`,
      ...(online
        ? [
            `server ${serverName}  ${online.client.players.size} players near  ${online.client.stats.corrections} corrections`,
          ]
        : []),
      `quads ${s.quads.toLocaleString()}  ${(s.bytes / 1048576).toFixed(1)} MiB  draws ${s.draws}`,
      `${online ? (worldInfo ? `seed ${worldInfo.seed}  ` : '') : `seed ${seed}  `}${scene.hours.toFixed(1)} h${ready ? '' : '  loading'}`,
      ...(photo?.on ? [`photo mode  ${photo.samples} samples`] : []),
    ]);
    if (!spawned)
      setOverlay(
        'loading',
        streamer
          ? `Generating the world: ${streamer.pending} chunks to load`
          : `Joining ${serverName}: ${loaded.size} chunks received`,
      );
  }

  function save(): void {
    const local = streamer;
    if (deterministic || !spawned || !local) return;
    local.save().catch((error) => local.onError(error));
    try {
      localStorage.setItem(
        saveName(),
        JSON.stringify({
          position: player.position,
          yaw,
          pitch,
          flying: player.flying,
          slots: hotbar.slots,
          selected: hotbar.selected,
        }),
      );
    } catch {
      // Storage full or blocked: the chunks still save.
    }
  }

  // The frame loop: our own, so each frame's CPU time (update + engine.render) can be measured.
  let last = 0,
    manual = false,
    sampler: { left: number; out: number[]; done: (cpu: number[]) => void } | undefined;
  const frame = (time: number): void => {
    if (!running) return;
    requestAnimationFrame(frame);
    if (manual || (runtime.pace && !runtime.pace(time))) return;
    const dt = last ? Math.min((time - last) / 1000, 0.1) : 0;
    last = time;
    const start = performance.now();
    try {
      update(dt);
      photo?.update(dt);
      engine.render({ delta: deterministic ? 0 : dt });
    } catch (error) {
      engine.onError(error);
      return;
    }
    const now = performance.now(),
      cpu = now - start;
    if (!ready) fillFrames.push(cpu);
    track(now);
    hud(now);
    if (sampler) {
      sampler.out.push(cpu);
      if (!--sampler.left) {
        const s = sampler;
        sampler = undefined;
        s.done(s.out);
      }
    }
    if (flight) {
      flight.cpu.push(cpu);
      if (!--flight.left) flight.done();
    }
  };
  // Back from a background tab: restart the clock so the first frame steps 0, not the time away (clamped or not).
  document.addEventListener('visibilitychange', () => (last = 0), { signal: events.signal });
  requestAnimationFrame(frame);
  setOverlay(deterministic ? 'hidden' : 'loading', joining ? `Joining ${serverName}` : 'Generating the world');

  const stats = () => ({
    ...voxels.stats,
    pending: pending(),
    loaded: loaded.size,
    chunkBytes: [...loaded.values()].reduce((sum, chunk) => sum + chunk.byteLength, 0),
    lightQueue: lightWork,
    distance,
    seed: online ? (worldInfo?.seed ?? 'unknown') : seed,
    tier,
    canvas: `${canvas.width}x${canvas.height}`,
    mesherWorkers: workers || 'default',
    streamerWorkers: streamer?.workers ?? 0,
    timestampQuery: !!runtime.gpu?.features.has('timestamp-query'),
  });
  const sandbox: Sandbox = {
    ready: false,
    get spawned() {
      return spawned;
    },
    world,
    get player() {
      return player;
    },
    get streamer() {
      return streamer;
    },
    get online() {
      return online;
    },
    get plazaWorld() {
      return worldInfo;
    },
    edit: sendEdit,
    get figures() {
      return figures;
    },
    get touch() {
      return touch;
    },
    voxels,
    get look() {
      return { yaw, pitch };
    },
    scene,
    get photo() {
      return photo;
    },
    loadPhoto,
    get target() {
      return hit;
    },
    timeline,
    stats,
    fillFrames,
    frames: (count) =>
      new Promise((done) => {
        sampler = { left: count, out: [], done };
      }),
    fly: (count, speed) =>
      new Promise((done) => {
        const cpu: number[] = [];
        flight = {
          left: count,
          speed,
          cpu,
          done: () => {
            flight = undefined;
            done({ cpu, stats: stats() });
          },
        };
      }),
    gpuTiming: (count) => gpuTiming(engine, count, (on) => (manual = on)),
  };
  Object.assign(window, { voxelSandbox: sandbox });

  // Joining. Every failure (the router says full or cannot be reached, a socket error or close, no welcome in time) ends
  // in goSolo: this page keeps its world, its input and its frame loop, with the banner saying why.
  function connect(url: string, wait: number): void {
    try {
      online = joinServer(world, url, {
        view: distance,
        name: plazaName(storage()),
        onClosed: (closed) => {
          const kind = closeKind(closed);
          if (kind === 'idle') idleOut();
          else if (kind === 'unreadable') goSolo('offline');
          else lost();
        },
      });
    } catch (error) {
      console.warn(error);
      return goSolo('offline');
    }
    online.client.onError = (error) => console.warn(error); // onClose follows and decides
    player = online.client.player;
    // A dynamic import: a page playing alone never downloads the figures, name tags or instancing.
    const joined = online;
    import('./figures.ts').then(
      ({ Figures }) => {
        if (online !== joined) return; // left the server while it loaded
        figures = new Figures(engine, {
          capacity: phone ? 128 : 512,
          tags: phone ? 12 : 32,
          ...(scene.shadows ? { castShadows: (crowd) => scene.shadows!.add(crowd) } : {}),
        });
      },
      (error) => {
        console.warn(error);
        toast('Other players could not load; check the connection');
      },
    );
    welcomeTimer = setTimeout(() => {
      if (online && !online.client.welcome) goSolo('offline');
    }, wait);
    if (routerUrl) setReport(report);
  }
  // The server closed us for being idle. Asking /join again would put the player straight back and defeat the limit, so
  // the page stays as it is: the world still shows, nothing more is sent (a closed client sends and edits nothing), and
  // the banner's Join button reloads when the player is back.
  function idleOut(): void {
    if (idled || solo) return;
    idled = true;
    clearTimeout(welcomeTimer);
    setReport(undefined);
    online?.dispose();
    setBanner(IDLE_BANNER, () => location.reload());
  }
  // The server closed on us. Only /join can say why: a new `world` id is a new world, the same id a shard that restarted.
  // Either way the way back is a reload through /join; no room or no router ends in the solo world within 5 s.
  function lost(): void {
    const router = routerUrl;
    if (!router) return goSolo('offline');
    setBanner('The connection dropped. Checking Plaza.');
    // Spread out: a whole world leaves at once at its end.
    const jitter = Math.random() * 3000;
    setTimeout(() => {
      joinPlaza(router, AbortSignal.timeout(JOIN_TIMEOUT - jitter)).then(
        (answer) => {
          if (answer.kind === 'full') return goSolo('full', answer.online);
          setBanner(answer.world !== worldId ? 'This world has ended. Joining the next one.' : 'Rejoining Plaza.');
          location.reload();
        },
        (error) => {
          console.warn(error);
          goSolo('offline');
        },
      );
    }, jitter);
  }
  function goSolo(kind: 'full' | 'offline', count?: number): void {
    if (solo || idled || deterministic) return;
    solo = true;
    clearTimeout(welcomeTimer);
    setReport(undefined);
    online?.dispose();
    online = undefined;
    worldInfo = undefined;
    edits.clear();
    figures?.dispose();
    figures = undefined;
    for (const key of [...loaded.keys()]) {
      const [cx, cy, cz] = key.split(',').map(Number);
      world.removeChunk(cx, cy, cz);
    }
    player = new VoxelCharacter(world);
    flyWanted = false;
    hit = null;
    spawned = false;
    ready = sandbox.ready = settled = false;
    restorePlayer();
    // The streamer loads around the camera, and the spawn below needs its own ground loaded: the camera goes there first.
    const here = saved?.position;
    aim(here ? [here[0], here[1] + EYE, here[2]] : [0.5, 40, 0.5]);
    // The streamer goes before the light in the plugin order, as when the page starts alone.
    engine.removePlugin(lightPlugin.name);
    streamer = startStreamer();
    engine.use(lightPlugin);
    const rejoin = () => location.reload(),
      router = routerUrl;
    setBanner(soloBanner(kind, count, !!router), rejoin);
    if (router) {
      const retry = setInterval(() => {
        if (document.hidden) return;
        joinPlaza(router, AbortSignal.timeout(JOIN_TIMEOUT)).then(
          (answer) =>
            setBanner(
              answer.kind === 'shard' ? 'Plaza has room now.' : soloBanner('full', answer.online, true),
              rejoin,
            ),
          () => setBanner(soloBanner('offline', undefined, true), rejoin),
        );
      }, RETRY);
      events.signal.addEventListener('abort', () => clearInterval(retry));
    }
  }
  if (serverUrl) connect(serverUrl, JOIN_TIMEOUT);
  else if (routerUrl) {
    const started = performance.now();
    joinPlaza(routerUrl, AbortSignal.timeout(JOIN_TIMEOUT)).then(
      (answer) => {
        if (answer.kind === 'full') return goSolo('full', answer.online);
        shard = answer.shard;
        worldId = answer.world;
        if (answer.seed !== undefined && answer.floor !== undefined)
          worldInfo = { seed: answer.seed, floor: answer.floor };
        connect(answer.url, Math.max(0, JOIN_TIMEOUT - (performance.now() - started)));
      },
      (error) => {
        console.warn(error);
        goSolo('offline');
      },
    );
  }
  if (import.meta.hot)
    import.meta.hot.dispose(() => {
      running = false;
      events.abort();
      void streamer?.dispose();
      online?.dispose();
      figures?.dispose();
      touch?.dispose();
      photo?.dispose();
      scene.dispose();
      engine.dispose();
    });
}

// GPU time of the voxel passes (opaque + cutout at order 1, translucent at 4.5) per frame, from timestamp queries
// written by empty compute passes just before and after them (render-browser-check.html's technique). Renders `count`
// frames itself, waiting for each, so the main loop pauses meanwhile. Null without the timestamp-query feature.
async function gpuTiming(engine: EngineKernel, count: number, pause: (on: boolean) => void): Promise<number[] | null> {
  const runtime = engineRuntime(engine),
    device = runtime.gpu;
  if (!device?.features.has('timestamp-query')) return null;
  const query = device.createQuerySet({ type: 'timestamp', count: 4 }),
    resolve = device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
    read = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    graph = runtime.frameGraph,
    stamp = (name: string, order: number, index: number) =>
      graph.add({
        name,
        order,
        execute: (c) => {
          if (c.backend === 'webgpu')
            c.encoder
              .beginComputePass({ timestampWrites: { querySet: query, beginningOfPassWriteIndex: index } })
              .end();
        },
      }),
    off = [
      stamp('voxel-sandbox:t0', 0.999, 0),
      stamp('voxel-sandbox:t1', 1.001, 1),
      stamp('voxel-sandbox:t2', 4.499, 2),
      stamp('voxel-sandbox:t3', 4.501, 3),
      graph.add({
        name: 'voxel-sandbox:t-resolve',
        order: 9.99,
        execute: (c) => {
          if (c.backend !== 'webgpu') return;
          c.encoder.resolveQuerySet(query, 0, 4, resolve, 0);
          c.encoder.copyBufferToBuffer(resolve, 0, read, 0, 32);
        },
      }),
    ],
    out: number[] = [];
  pause(true);
  try {
    for (let i = 0; i < count; i++) {
      engine.render({ delta: 0 });
      await read.mapAsync(GPUMapMode.READ);
      const t = new BigInt64Array(read.getMappedRange().slice(0));
      read.unmap();
      out.push(Number(t[1] - t[0] + t[3] - t[2]) / 1e6);
    }
  } finally {
    for (const f of off) f();
    pause(false);
    query.destroy();
    resolve.destroy();
    read.destroy();
  }
  return out;
}

/** The 12 edges of cell (x, y, z) grown by 0.004 (inset by `inset` at the sides and top for plants), as segments. */
function cellBox(x: number, y: number, z: number, inset = 0): number[] {
  const e = 0.004,
    a = [x + inset - e, y - e, z + inset - e],
    b = [x + 1 - inset + e, y + 1 - inset + e, z + 1 - inset + e],
    corner = (i: number) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]],
    out: number[] = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) out.push(...corner(i), ...corner(i | bit));
  return out;
}

// localStorage, or nothing where reading it throws (blocked storage).
function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

const farFor = (chunks: number) => (chunks + 2) * 32 * 1.5;
const saveName = () => `margo-voxel-sandbox-seed-${seed}`;
// IndexedDB, or memory where the browser has none (some private windows): the world then lasts until the tab closes.
function openStore(): IndexedDBChunkStore | MemoryChunkStore {
  try {
    return new IndexedDBChunkStore(saveName());
  } catch (error) {
    console.warn(error);
    setTimeout(() => toast('This browser cannot save the world (no IndexedDB): edits last until the tab closes'), 0);
    return new MemoryChunkStore();
  }
}

interface SavedPlayer {
  position: Vec3;
  yaw: number;
  pitch: number;
  flying: boolean;
  slots: string[];
  selected: number;
}
function loadPlayer(): SavedPlayer | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(saveName()) ?? 'null') as SavedPlayer | null;
    return value && value.position.every(Number.isFinite) ? value : undefined;
  } catch {
    return undefined;
  }
}
// ?reset: deletes this seed's saved chunks and player, then reloads without the parameter.
async function resetSave(): Promise<void> {
  try {
    localStorage.removeItem(saveName());
  } catch {
    // Storage blocked: nothing saved there.
  }
  await new Promise<void>((done) => {
    const request = indexedDB.deleteDatabase(saveName());
    request.onsuccess = request.onerror = request.onblocked = () => done();
  });
  params.delete('reset');
  location.replace(`${location.pathname}${params.size ? `?${params}` : ''}`);
  await new Promise(() => {}); // the page is going away
}

boot().catch(showError);
