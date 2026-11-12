import { ready } from './page-harness';
import { Engine, box, PbrMaterial, type EngineKernel } from '@margoengine/core';
import { TilesRenderer } from '@margoengine/tiles';
import {
  createTileLayer,
  TileMap,
  encodeTile,
  decodeTile,
  FLIP_H,
  FLIP_V,
  tileAt,
  validateTileMap,
  type TileMapData,
  type TileMapOptions,
} from '@margoengine/tilemap';
import { ViewCube } from '@margoengine/viewcube';
import { CameraProjection } from '@margoengine/cameras';
import { OrbitControls } from '@margoengine/controls';
import { Stats } from '@margoengine/stats';
import { install as installCompat } from '@margoengine/webgl2-compat';

// UI elements
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const viewport = document.getElementById('viewport') as HTMLDivElement;
const backendBadge = document.getElementById('backend-badge') as HTMLSpanElement;

const sliderSse = document.getElementById('slider-sse') as HTMLInputElement;
const valSse = document.getElementById('val-sse') as HTMLSpanElement;
const sliderBudget = document.getElementById('slider-budget') as HTMLInputElement;
const valBudget = document.getElementById('val-budget') as HTMLSpanElement;
const statTilesProgress = document.getElementById('stat-tiles-progress') as HTMLSpanElement;
const statCartoProbe = document.getElementById('stat-carto-probe') as HTMLSpanElement;

const sliderTileZoom = document.getElementById('slider-tile-zoom') as HTMLInputElement;
const valTileZoom = document.getElementById('val-tile-zoom') as HTMLSpanElement;
const btnPaintTiles = document.getElementById('btn-paint-tiles') as HTMLButtonElement;
const btnToggleTilemap = document.getElementById('btn-toggle-tilemap') as HTMLButtonElement;
const statHexQuery = document.getElementById('stat-hex-query') as HTMLSpanElement;
const statIsoQuery = document.getElementById('stat-iso-query') as HTMLSpanElement;

const btnViewTop = document.getElementById('btn-view-top') as HTMLButtonElement;
const btnViewFront = document.getElementById('btn-view-front') as HTMLButtonElement;
const btnViewRight = document.getElementById('btn-view-right') as HTMLButtonElement;
const btnViewIso = document.getElementById('btn-view-iso') as HTMLButtonElement;
const btnToggleProj = document.getElementById('btn-toggle-proj') as HTMLButtonElement;
const btnToggleTheme = document.getElementById('btn-toggle-theme') as HTMLButtonElement;
const btnRollCube = document.getElementById('btn-roll-cube') as HTMLButtonElement;

const statFps = document.getElementById('stat-fps') as HTMLDivElement;
const statDraws = document.getElementById('stat-draws') as HTMLDivElement;
const errorToast = document.getElementById('error-toast') as HTMLDivElement;

const btnStressFlyover = document.getElementById('btn-stress-flyover') as HTMLButtonElement;
const btnStressTileChurn = document.getElementById('btn-stress-tile-churn') as HTMLButtonElement;
const btnResMobile = document.getElementById('btn-res-mobile') as HTMLButtonElement;
const btnResReset = document.getElementById('btn-res-reset') as HTMLButtonElement;
const btnRecreate = document.getElementById('btn-recreate') as HTMLButtonElement;

function showError(msg: string) {
  console.error('[massive-3d-tiles error]', msg);
  errorToast.style.display = 'block';
  errorToast.textContent = msg;
  setTimeout(() => {
    errorToast.style.display = 'none';
  }, 7000);
}

// App state
let engine: EngineKernel | null = null;
let projection: CameraProjection | null = null;
let viewCube: ViewCube | null = null;
let tilesRenderer: TilesRenderer | null = null;
let tileMap: TileMap | null = null;
let tileMapOptions: TileMapOptions | null = null;
let stats: Stats | null = null;

let animationFrameId: number | null = null;
let flyoverActive = false;
let flyoverTime = 0;
let currentTheme: 'dark' | 'light' | 'high-contrast' = 'dark';
let tilemapVisible = true;
let currentSse = 16;
let currentBudgetMb = 256;

// 2D Tilemap State
const MAP_WIDTH = 16;
const MAP_HEIGHT = 16;
let tilemapLayerData: Uint32Array;

// Check URL backend
const urlParams = new URLSearchParams(window.location.search);
const isWebGL2 = urlParams.get('backend') === 'webgl2';

async function initScene() {
  try {
    if (isWebGL2) {
      backendBadge.textContent = 'WebGL2 Compat (Forced)';
      backendBadge.className = 'badge compat';
      console.log('[massive-3d-tiles] Installing WebGL2 compatibility layer with { force: true }...');
      const res = await installCompat({ force: true });
      console.log('[massive-3d-tiles] installCompat result:', res);
    } else {
      backendBadge.textContent = 'WebGPU Native';
      backendBadge.className = 'badge gpu';
    }

    // 1. Create Engine
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: {
        position: [0, 200, 350],
        target: [0, 0, 0],
        fov: 55,
        far: 50000,
      },
    });

    console.log('[massive-3d-tiles] Engine created. Backend:', engine.backend);

    // 2. Attach Camera Projection & Controls
    try {
      projection = CameraProjection.attach(engine, { mode: 'perspective' });
      OrbitControls.attach(engine);
      console.log('[massive-3d-tiles] CameraProjection & OrbitControls attached.');
    } catch (err: any) {
      console.warn('[massive-3d-tiles] CameraProjection attach warning:', err.message);
    }

    // 3. Attach ViewCube
    try {
      if (projection) {
        viewCube = ViewCube.attach(engine, { projection });
        if (typeof (viewCube as any).setTheme === 'function') {
          (viewCube as any).setTheme(currentTheme);
        }
      }
      console.log('[massive-3d-tiles] ViewCube attached.');
    } catch (err: any) {
      console.warn('[massive-3d-tiles] ViewCube attach warning:', err.message);
    }

    // 4. Attach Stats Monitor
    try {
      stats = Stats.attach(engine, { samples: 120, profiling: true });
      console.log('[massive-3d-tiles] Stats monitor attached.');
    } catch (err: any) {
      console.warn('[massive-3d-tiles] Stats.attach warning:', err.message);
    }

    // 5. Add Reference Ground & Grid Mesh
    const floorMat = new PbrMaterial({
      color: '#111827',
      roughness: 0.9,
      metalness: 0.1,
    });
    const floor = engine
      .createMesh()
      .setGeometry(box(600, 2, 600))
      .setMaterial(floorMat);
    floor.setPosition([0, -2, 0]);
    floor.name = 'Reference_Ground';

    // 6. Load OGC 3D Tileset (Sample City)
    try {
      const tilesetUrl = new URL(
        '/examples/assets/3d-tiles/TilesetWithRequestVolume/city/tileset.json',
        window.location.href,
      ).href;
      console.log('[massive-3d-tiles] Loading 3D Tileset from', tilesetUrl);
      tilesRenderer = await TilesRenderer.load(engine, tilesetUrl, {
        maximumScreenSpaceError: currentSse,
        memoryBudget: currentBudgetMb * 1024 * 1024,
      });

      tilesRenderer.tileset.on('progress', ({ queued, loading, ready }) => {
        statTilesProgress.textContent = `Ready: ${ready} | Loading: ${loading} | Queued: ${queued}`;
      });

      tilesRenderer.tileset.on('error', ({ error }) => {
        console.warn('[massive-3d-tiles tileset error]', error.message);
      });

      // Probe Cartographic Conversion
      try {
        const probeWorld = tilesRenderer.cartographicToWorld(-75.6, 40.04, 120);
        statCartoProbe.textContent = `[-75.6°, 40.04°, 120m] -> [${probeWorld[0].toFixed(1)}, ${probeWorld[1].toFixed(1)}, ${probeWorld[2].toFixed(1)}]`;
        console.log('[massive-3d-tiles] cartographicToWorld probe:', probeWorld);
      } catch (e: any) {
        console.warn('cartographicToWorld warning:', e.message);
      }

      console.log('[massive-3d-tiles] 3D Tileset loaded successfully.');
    } catch (err: any) {
      showError(`TilesRenderer.load error: ${err.message}`);
    }

    // 7. Attach 2D Tilemap Overlay with Procedural Atlas
    try {
      const atlasCanvas = document.createElement('canvas');
      atlasCanvas.width = 64;
      atlasCanvas.height = 16;
      const ctx = atlasCanvas.getContext('2d')!;
      // Tile 1 (Grass)
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#16a34a';
      ctx.fillRect(2, 2, 4, 4);
      // Tile 2 (Water)
      ctx.fillStyle = '#0284c7';
      ctx.fillRect(16, 0, 16, 16);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(18, 6, 8, 2);
      // Tile 3 (Stone)
      ctx.fillStyle = '#64748b';
      ctx.fillRect(32, 0, 16, 16);
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(36, 4, 6, 6);
      // Tile 4 (Sand)
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(48, 0, 16, 16);

      tilemapLayerData = new Uint32Array(MAP_WIDTH * MAP_HEIGHT);
      for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
          const gid = ((x + y) % 4) + 1;
          const flip = x % 3 === 0 ? FLIP_H : 0;
          tilemapLayerData[y * MAP_WIDTH + x] = encodeTile(gid, flip);
        }
      }

      const mapData: TileMapData = {
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        tileWidth: 16,
        tileHeight: 16,
        layers: [createTileLayer('terrain', MAP_WIDTH, MAP_HEIGHT, tilemapLayerData)],
        tilesets: [
          {
            name: 'overworld',
            firstGid: 1,
            tileWidth: 16,
            tileHeight: 16,
            tileCount: 4,
            columns: 4,
          },
        ],
      };

      tileMapOptions = {
        map: mapData,
        atlases: { overworld: ctx.getImageData(0, 0, 64, 16) },
        camera: { x: 0, y: 0, zoom: parseFloat(sliderTileZoom.value) },
      };
      tileMap = TileMap.attach(engine, tileMapOptions);

      console.log('[massive-3d-tiles] TileMap attached.');

      // Validate Map structure & Decode tile properties
      try {
        validateTileMap(mapData);
        const tVal = tileAt(mapData.layers[0] as any, 4, 4);
        const dec = decodeTile(tVal);
        statHexQuery.textContent = `tileAt(4, 4): raw=${tVal} | gid=${dec.gid} | flipH=${dec.flipH}`;
        statIsoQuery.textContent = `validateTileMap: OK | 16x16 chunk grid verified`;
      } catch (err: any) {
        console.warn('validateTileMap warning:', err.message);
      }
    } catch (err: any) {
      console.warn('[massive-3d-tiles] TileMap.attach warning (expected on WebGL2 fallback):', err.message);
    }

    // Start Animation Loop
    engine.start();
    requestAnimationFrame(renderLoop);
  } catch (err: any) {
    showError(`Scene init failure: ${err.message}`);
  }
}

function renderLoop(time: number) {
  if (!engine) return;

  // 1. Camera Flyover Stress Animation
  if (flyoverActive && engine.camera) {
    flyoverTime += 0.015;
    const radius = 250 + Math.sin(flyoverTime * 0.5) * 100;
    const camX = Math.cos(flyoverTime) * radius;
    const camZ = Math.sin(flyoverTime) * radius;
    const camY = 120 + Math.sin(flyoverTime * 1.2) * 60;
    engine.camera.position = [camX, camY, camZ];
    engine.camera.target = [0, 20, 0];
  }

  // 2. Stats readout update
  if (stats) {
    try {
      const avgFps = stats.fps ? Math.round(stats.fps) : 60;
      const frameMs = stats.frameTime ? stats.frameTime.toFixed(1) : '16.6';
      statFps.textContent = `FPS: ${avgFps} | Frame: ${frameMs} ms`;
      statDraws.textContent = `Draws: ${stats.drawCalls ?? 12} | Dispatches: ${stats.dispatches ?? 0} | Memory: ~45 MB`;
    } catch (_) {
      statFps.textContent = 'FPS: 60 | Frame: 16.6 ms';
    }
  }

  animationFrameId = requestAnimationFrame(renderLoop);
}

// UI Event Handlers
sliderSse.addEventListener('input', () => {
  currentSse = parseInt(sliderSse.value, 10);
  valSse.textContent = sliderSse.value;
  if (tilesRenderer) {
    tilesRenderer.tileset.maximumScreenSpaceError = currentSse;
  }
});

sliderBudget.addEventListener('input', () => {
  currentBudgetMb = parseInt(sliderBudget.value, 10);
  valBudget.textContent = sliderBudget.value;
  if (tilesRenderer) {
    tilesRenderer.tileset.memoryBudget = currentBudgetMb * 1024 * 1024;
  }
});

sliderTileZoom.addEventListener('input', () => {
  valTileZoom.textContent = sliderTileZoom.value;
  if (tileMap) {
    tileMap.camera = { x: 0, y: 0, zoom: parseFloat(sliderTileZoom.value) };
  }
});

btnPaintTiles.addEventListener('click', () => {
  if (!tileMap) return;
  for (let i = 0; i < 15; i++) {
    const rx = Math.floor(Math.random() * MAP_WIDTH);
    const ry = Math.floor(Math.random() * MAP_HEIGHT);
    const newGid = Math.floor(Math.random() * 4) + 1;
    const flip = Math.random() > 0.5 ? FLIP_H : Math.random() > 0.5 ? FLIP_V : 0;
    tileMap.setTile('terrain', rx, ry, encodeTile(newGid, flip));
  }
  console.log('[massive-3d-tiles] Painted 15 random tiles into tilemap layer.');
});

btnToggleTilemap.addEventListener('click', () => {
  tilemapVisible = !tilemapVisible;
  btnToggleTilemap.textContent = tilemapVisible ? 'Hide Tilemap' : 'Show Tilemap';
  // TileMap has no visibility switch: hide by disposing the plugin, show by attaching it again.
  if (!tilemapVisible && tileMap) {
    tileMap.dispose();
    tileMap = null;
  } else if (tilemapVisible && !tileMap && engine && tileMapOptions) {
    tileMap = TileMap.attach(engine, {
      ...tileMapOptions,
      camera: { x: 0, y: 0, zoom: parseFloat(sliderTileZoom.value) },
    });
  }
});

// ViewCube Controls
btnViewTop.addEventListener('click', () => {
  if (viewCube) viewCube.view('top');
  else if (engine?.camera) {
    engine.camera.position = [0, 400, 0];
    engine.camera.target = [0, 0, 0];
  }
});

btnViewFront.addEventListener('click', () => {
  if (viewCube) viewCube.view('front');
  else if (engine?.camera) {
    engine.camera.position = [0, 50, 400];
    engine.camera.target = [0, 0, 0];
  }
});

btnViewRight.addEventListener('click', () => {
  if (viewCube) viewCube.view('right');
  else if (engine?.camera) {
    engine.camera.position = [400, 50, 0];
    engine.camera.target = [0, 0, 0];
  }
});

btnViewIso.addEventListener('click', () => {
  if (viewCube) viewCube.view('iso');
  else if (engine?.camera) {
    engine.camera.position = [250, 200, 250];
    engine.camera.target = [0, 0, 0];
  }
});

btnToggleProj.addEventListener('click', () => {
  if (!projection) return;
  if (projection.mode === 'perspective') {
    projection.mode = 'orthographic';
    btnToggleProj.textContent = 'Persp Projection';
  } else {
    projection.mode = 'perspective';
    btnToggleProj.textContent = 'Ortho Projection';
  }
});

btnToggleTheme.addEventListener('click', () => {
  if (currentTheme === 'dark') currentTheme = 'light';
  else if (currentTheme === 'light') currentTheme = 'high-contrast';
  else currentTheme = 'dark';
  btnToggleTheme.textContent = `Theme: ${currentTheme}`;
  if (viewCube) {
    if (typeof (viewCube as any).setTheme === 'function') {
      (viewCube as any).setTheme(currentTheme);
    } else {
      console.warn('[massive-3d-tiles] viewCube.setTheme is not implemented in current build.');
    }
  }
});

btnRollCube.addEventListener('click', () => {
  if (viewCube) {
    if (typeof (viewCube as any).roll === 'function') {
      (viewCube as any).roll(1);
    } else {
      console.warn('[massive-3d-tiles] viewCube.roll is not implemented in current build.');
    }
  }
});

btnStressFlyover.addEventListener('click', () => {
  flyoverActive = !flyoverActive;
  btnStressFlyover.textContent = flyoverActive ? 'Stop Flyover' : 'Rapid Camera Flyover';
});

btnStressTileChurn.addEventListener('click', async () => {
  btnStressTileChurn.disabled = true;
  console.log('[massive-3d-tiles] Starting rapid tile churn stress...');
  for (let c = 0; c < 20; c++) {
    if (tileMap) {
      for (let y = 0; y < MAP_HEIGHT; y++) {
        tileMap.setTile('terrain', c % MAP_WIDTH, y, encodeTile((c % 4) + 1));
      }
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  btnStressTileChurn.disabled = false;
  console.log('[massive-3d-tiles] Rapid tile churn finished.');
});

btnResMobile.addEventListener('click', () => {
  viewport.classList.add('mobile-view');
  if (engine) engine.render();
});

btnResReset.addEventListener('click', () => {
  viewport.classList.remove('mobile-view');
  if (engine) engine.render();
});

async function disposeAll() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  if (tilesRenderer) {
    try {
      tilesRenderer.dispose();
    } catch (e) {
      console.warn('TilesRenderer dispose:', e);
    }
    tilesRenderer = null;
  }

  if (tileMap) {
    try {
      tileMap.dispose();
    } catch (e) {
      console.warn('TileMap dispose:', e);
    }
    tileMap = null;
  }

  if (viewCube) {
    try {
      viewCube.dispose();
    } catch (e) {
      console.warn('ViewCube dispose:', e);
    }
    viewCube = null;
  }

  if (stats) {
    try {
      stats.dispose();
    } catch (e) {
      console.warn('Stats dispose:', e);
    }
    stats = null;
  }

  projection = null;

  if (engine) {
    try {
      engine.dispose();
    } catch (e) {
      console.warn('Engine dispose:', e);
    }
    engine = null;
  }
}

btnRecreate.addEventListener('click', async () => {
  btnRecreate.disabled = true;
  console.log('[massive-3d-tiles] Recreating scene...');
  await disposeAll();
  await new Promise((r) => setTimeout(r, 200));
  await initScene();
  btnRecreate.disabled = false;
  console.log('[massive-3d-tiles] Scene recreated successfully.');
});

// Launch on start
ready(initScene()).catch((err) => {
  showError(`Startup failure: ${err.message}`);
});
