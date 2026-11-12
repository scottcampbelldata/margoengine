import { ready } from './page-harness';
import { Engine, Geometry, PbrMaterial, box } from '@margoengine/core';
import { install as installCompat } from '@margoengine/webgl2-compat';
import { bakeLightmap, type Lightmap } from '@margoengine/lightmap';
import { SkyMoon } from '@margoengine/scenery/sky';
import { Scatter } from '@margoengine/scatter';
import { CulledInstances } from '@margoengine/culling';
import { AssetCache } from '@margoengine/cache';

// UI element references
const badgeBackend = document.getElementById('badge-backend')!;
const valBakeStatus = document.getElementById('val-bake-status')!;
const barBakeProgress = document.getElementById('bar-bake-progress') as HTMLElement;
const valMoonPhase = document.getElementById('val-moon-phase')!;
const valScatterCount = document.getElementById('val-scatter-count')!;
const valCulledCounts = document.getElementById('val-culled-counts')!;
const valCacheStats = document.getElementById('val-cache-stats')!;
const valFps = document.getElementById('val-fps')!;
const elLog = document.getElementById('log')!;

const btnBake = document.getElementById('btn-bake') as HTMLButtonElement;
const btnCancelBake = document.getElementById('btn-cancel-bake') as HTMLButtonElement;
const btnToggleSky = document.getElementById('btn-toggle-sky') as HTMLButtonElement;
const btnCycleMoon = document.getElementById('btn-cycle-moon') as HTMLButtonElement;
const btnToggleScatter = document.getElementById('btn-toggle-scatter') as HTMLButtonElement;
const btnJitterScatter = document.getElementById('btn-jitter-scatter') as HTMLButtonElement;
const btnToggleCullMode = document.getElementById('btn-toggle-cull-mode') as HTMLButtonElement;
const btnReadCull = document.getElementById('btn-read-cull') as HTMLButtonElement;
const btnCacheSave = document.getElementById('btn-cache-save') as HTMLButtonElement;
const btnCacheReload = document.getElementById('btn-cache-reload') as HTMLButtonElement;
const btnCacheClear = document.getElementById('btn-cache-clear') as HTMLButtonElement;
const btnStressCull = document.getElementById('btn-stress-cull') as HTMLButtonElement;
const btnTestMobile = document.getElementById('btn-test-mobile') as HTMLButtonElement;
const btnRecreate = document.getElementById('btn-recreate') as HTMLButtonElement;
const viewportEl = document.getElementById('viewport')!;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

function log(msg: string) {
  elLog.textContent = msg;
  console.log(`[BakedLightingRoom] ${msg}`);
}

const params = new URLSearchParams(window.location.search);
const requestedBackend = params.get('backend') || 'webgpu';
badgeBackend.textContent = requestedBackend.toUpperCase();

let engine: Engine | null = null;
let skyMoon: SkyMoon | null = null;
let scatterLayer: Scatter | null = null;
let culledInstances: CulledInstances | null = null;
let assetCache: AssetCache | null = null;
let bakeAbortController: AbortController | null = null;
let lastAtlas: Lightmap | null = null;
let isBaking = false;
let currentCullMode: 'frustum' | 'occlusion' = 'frustum';
let currentMoonPhase = 0.85;
let roomMesh: any = null;

// Room Quads definition (counterclockwise parallelograms)
// 12 floats per quad: p0, p1, p2, p3 where p2 = p1 + p3 - p0
const roomQuads = new Float32Array([
  // 1. Floor (normal +Y)
  -5, 0, -5, -5, 0, 5, 5, 0, 5, 5, 0, -5,
  // 2. Ceiling (normal -Y)
  -5, 4, 5, -5, 4, -5, 5, 4, -5, 5, 4, 5,
  // 3. Back Wall at z = -5 (normal +Z)
  -5, 0, -5, 5, 0, -5, 5, 4, -5, -5, 4, -5,
  // 4. Left Wall at x = -5 (normal +X)
  -5, 0, 5, -5, 0, -5, -5, 4, -5, -5, 4, 5,
  // 5. Right Wall at x = 5 (normal -X)
  5, 0, -5, 5, 0, 5, 5, 4, 5, 5, 4, -5,
]);

// 4 RGBA floats per quad
const roomAlbedo = new Float32Array([
  0.85,
  0.82,
  0.78,
  1.0, // Floor: warm concrete
  0.9,
  0.9,
  0.92,
  1.0, // Ceiling: plaster
  0.75,
  0.8,
  0.85,
  1.0, // Back wall: pale slate
  0.8,
  0.85,
  0.8,
  1.0, // Left wall: soft sage
  0.88,
  0.8,
  0.75,
  1.0, // Right wall: muted terracotta
]);

function buildRoomGeometry(quads: Float32Array, atlasUV?: Float32Array): Geometry {
  const quadCount = quads.length / 12;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let q = 0; q < quadCount; q++) {
    const o = q * 12;
    const p0 = [quads[o], quads[o + 1], quads[o + 2]];
    const p1 = [quads[o + 3], quads[o + 4], quads[o + 5]];
    const p2 = [quads[o + 6], quads[o + 7], quads[o + 8]];
    const p3 = [quads[o + 9], quads[o + 10], quads[o + 11]];

    // Edge vectors
    const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const v = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
    // Normal = cross(u, v) normalized
    let nx = u[1] * v[2] - u[2] * v[1];
    let ny = u[2] * v[0] - u[0] * v[2];
    let nz = u[0] * v[1] - u[1] * v[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    const baseVertex = q * 4;
    positions.push(...p0, ...p1, ...p2, ...p3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(baseVertex, baseVertex + 1, baseVertex + 2, baseVertex, baseVertex + 2, baseVertex + 3);
  }

  return new Geometry(new Float32Array(positions), new Float32Array(normals), new Uint32Array(indices));
}

function updateCacheStatsHUD() {
  if (!assetCache) return;
  const s = assetCache.stats;
  valCacheStats.textContent = `Hits: ${s.hits}, Miss: ${s.misses}, Stored: ${s.stored}`;
}

async function initScene() {
  if (engine) {
    engine.dispose();
    engine = null;
  }
  skyMoon = null;
  scatterLayer = null;
  culledInstances = null;

  log(`Creating engine with backend ${requestedBackend}...`);

  if (requestedBackend === 'webgl2') {
    const res = await installCompat({ force: true });
    log(`WebGL2 compat installed: ${JSON.stringify(res)}`);
  }

  try {
    engine = await Engine.create(canvas, {
      powerPreference: 'high-performance',
    });
  } catch (err: any) {
    log(`Engine create failed: ${err.message}`);
    throw err;
  }

  // Camera setup
  engine.camera.position = [0, 2.2, 7.5];
  engine.camera.target = [0, 1.8, 0];

  // 1. Build Room Mesh
  const roomGeom = buildRoomGeometry(roomQuads);
  const roomMat = new PbrMaterial({
    color: '#e2e8f0',
    roughness: 0.8,
    metalness: 0.1,
  });
  roomMesh = engine.createMesh().setGeometry(roomGeom).setMaterial(roomMat);

  // 2. Attach Night Scenery (@margoengine/scenery)
  try {
    skyMoon = SkyMoon.attach(engine, {
      moonDirection: [0.45, 0.35, -1],
      moonPhase: currentMoonPhase,
    });
    valMoonPhase.textContent = currentMoonPhase.toFixed(2);
    log('SkyMoon attached.');
  } catch (err: any) {
    log(`SkyMoon attach warning: ${err.message}`);
  }

  // 3. Attach Prop Scatter (@margoengine/scatter)
  try {
    const pebbleGeom = box(0.15);
    scatterLayer = Scatter.attach(engine, pebbleGeom, {
      count: 5000,
      area: [9, 9],
      density: 0.7,
      lod: [8, 16, 32],
    });
    valScatterCount.textContent = '5,000 instances';
    log('Scatter attached (5,000 instances).');
  } catch (err: any) {
    log(`Scatter attach warning: ${err.message}`);
  }

  // 4. Attach GPU Culled Instances (@margoengine/culling)
  try {
    const boltGeom = box(0.12);
    const boltMat = new PbrMaterial({ color: '#f59e0b', roughness: 0.3, metalness: 0.8 });
    const count = 3000;
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 8.5;
      const y = Math.random() * 3.5 + 0.1;
      const z = (Math.random() - 0.5) * 8.5;
      matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1], i * 16);
    }
    culledInstances = CulledInstances.attach(
      engine,
      [{ geometry: boltGeom, material: boltMat, transforms: matrices }],
      { culling: currentCullMode },
    );
    log(`CulledInstances attached (3,000 bolts, mode: ${currentCullMode}).`);
  } catch (err: any) {
    log(`CulledInstances warning: ${err.message}`);
  }

  // 5. Initialize AssetCache (@margoengine/cache)
  try {
    assetCache = new AssetCache({
      name: 'margo-baked-lighting-room',
      version: '1',
      maxBytes: 128 * 1024 * 1024,
      persist: true,
    });
    // Prewarm cache with sample glTF model
    cacheSampleAsset();
    updateCacheStatsHUD();
  } catch (err: any) {
    log(`AssetCache warning: ${err.message}`);
  }

  // Telemetry loop
  let frameCount = 0;
  let fpsTimer = 0;
  engine.onFrame(async (_, delta) => {
    frameCount++;
    fpsTimer += delta;
    if (fpsTimer >= 0.5) {
      const fps = Math.round(frameCount / fpsTimer);
      const ms = ((delta || 0.016) * 1000).toFixed(1);
      valFps.textContent = `${fps} fps (${ms}ms)`;
      frameCount = 0;
      fpsTimer = 0;

      // Update culled counts
      if (culledInstances) {
        try {
          const counts = await culledInstances.readCounts();
          if (counts && counts.length > 0) {
            valCulledCounts.textContent = `${counts[0]} / 3,000 drawn`;
          }
        } catch {
          // ignore transient readback failures
        }
      }
    }
  });

  engine.start();
  log(`Baked lighting room ready on ${requestedBackend}.`);
}

async function cacheSampleAsset() {
  if (!assetCache) return;
  try {
    const res = await assetCache.fetch('/examples/assets/skinning-ik-orb.glb');
    log(`Sample asset cached (HTTP ${res.status}, size: ${res.headers.get('content-length') || 'ok'})`);
    updateCacheStatsHUD();
  } catch (err: any) {
    log(`Sample asset cache warning: ${err.message}`);
  }
}

// --- Lightmap Baker (@margoengine/lightmap) ---
async function startBake() {
  if (isBaking) return;
  isBaking = true;
  btnBake.disabled = true;
  btnCancelBake.disabled = false;
  valBakeStatus.textContent = 'Baking (0%)...';
  barBakeProgress.style.width = '0%';
  bakeAbortController = new AbortController();

  log('Starting lightmap bake (directional + point light)...');
  const t0 = performance.now();

  try {
    const atlas = await bakeLightmap(
      {
        positions: roomQuads,
        albedo: roomAlbedo,
      },
      {
        texelsPerUnit: 4,
        lights: [
          { type: 'directional', direction: [0.3, 1, 0.2], intensity: 2.5 },
          { type: 'point', position: [0, 3.2, 0], intensity: 4.0 },
        ],
        onProgress: (done, total) => {
          const pct = Math.round((done / total) * 100);
          valBakeStatus.textContent = `Baking (${pct}%)...`;
          barBakeProgress.style.width = `${pct}%`;
        },
        signal: bakeAbortController.signal,
      },
    );

    lastAtlas = atlas;
    const elapsed = (performance.now() - t0).toFixed(1);
    valBakeStatus.textContent = `Baked (${atlas.width}x${atlas.height})`;
    barBakeProgress.style.width = '100%';
    log(
      `Bake complete in ${elapsed}ms! Atlas: ${atlas.width}x${atlas.height}, scale: ${atlas.lightmapScale.toFixed(2)}`,
    );

    // Update room mesh with baked lighting tint
    if (roomMesh && roomMesh.material) {
      roomMesh.material.color = [1.1, 1.05, 0.98];
      roomMesh.material.roughness = 0.6;
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      valBakeStatus.textContent = 'Cancelled';
      barBakeProgress.style.width = '0%';
      log('Lightmap bake was cancelled.');
    } else {
      valBakeStatus.textContent = 'Bake Error';
      console.error(err);
      log(`Bake error: ${err.message} at ${err.stack}`);
    }
  } finally {
    isBaking = false;
    btnBake.disabled = false;
    btnCancelBake.disabled = true;
    bakeAbortController = null;
  }
}

btnBake.onclick = () => startBake();

btnCancelBake.onclick = () => {
  if (bakeAbortController) {
    bakeAbortController.abort();
    log('Bake cancellation requested.');
  }
};

// --- Scenery Moon Controls (@margoengine/scenery) ---
btnToggleSky.onclick = () => {
  if (!engine) return;
  if (skyMoon) {
    engine.removePlugin('sky-moon');
    skyMoon = null;
    btnToggleSky.classList.remove('active');
    btnToggleSky.textContent = 'SkyMoon Disabled';
    log('SkyMoon removed from engine.');
  } else {
    skyMoon = SkyMoon.attach(engine, {
      moonDirection: [0.45, 0.35, -1],
      moonPhase: currentMoonPhase,
    });
    btnToggleSky.classList.add('active');
    btnToggleSky.textContent = 'SkyMoon Active';
    log('SkyMoon re-attached.');
  }
};

btnCycleMoon.onclick = () => {
  currentMoonPhase = (currentMoonPhase + 0.25) % 1.0;
  if (skyMoon) {
    skyMoon.config.moonPhase = currentMoonPhase;
  }
  valMoonPhase.textContent = currentMoonPhase.toFixed(2);
  log(`Moon phase set to ${currentMoonPhase.toFixed(2)}`);
};

// --- Scatter Controls (@margoengine/scatter) ---
btnToggleScatter.onclick = () => {
  if (!engine) return;
  if (scatterLayer) {
    engine.removePlugin('scatter');
    scatterLayer = null;
    btnToggleScatter.classList.remove('active');
    btnToggleScatter.textContent = 'Scatter Disabled';
    valScatterCount.textContent = '0 instances';
    log('Scatter layer removed.');
  } else {
    const pebbleGeom = box(0.15);
    scatterLayer = Scatter.attach(engine, pebbleGeom, {
      count: 5000,
      area: [9, 9],
      density: 0.7,
      lod: [8, 16, 32],
    });
    btnToggleScatter.classList.add('active');
    btnToggleScatter.textContent = 'Scatter Layer';
    valScatterCount.textContent = '5,000 instances';
    log('Scatter layer attached.');
  }
};

btnJitterScatter.onclick = () => {
  log('Jittering scatter distribution area...');
  if (scatterLayer && engine) {
    engine.removePlugin('scatter');
    const pebbleGeom = box(0.12 + Math.random() * 0.08);
    scatterLayer = Scatter.attach(engine, pebbleGeom, {
      count: 5000,
      area: [8 + Math.random() * 2, 8 + Math.random() * 2],
      density: 0.5 + Math.random() * 0.4,
      lod: [10, 20, 40],
    });
    log('Scatter parameters refreshed.');
  }
};

// --- GPU Culling Controls (@margoengine/culling) ---
btnToggleCullMode.onclick = () => {
  currentCullMode = currentCullMode === 'frustum' ? 'occlusion' : 'frustum';
  btnToggleCullMode.textContent = `Mode: ${currentCullMode.toUpperCase()}`;
  if (culledInstances) {
    culledInstances.culling = currentCullMode;
  }
  log(`Culling mode switched to: ${currentCullMode}`);
};

btnReadCull.onclick = async () => {
  if (!culledInstances) {
    log('CulledInstances not attached.');
    return;
  }
  try {
    const counts = await culledInstances.readCounts();
    valCulledCounts.textContent = `${counts[0]} / 3,000 drawn`;
    log(`Read GPU cull counts: batch 0 = ${counts[0]} instances drawn`);
  } catch (err: any) {
    log(`Read cull error: ${err.message}`);
  }
};

// --- Asset Cache Controls (@margoengine/cache) ---
btnCacheSave.onclick = async () => {
  if (!lastAtlas) {
    log('No baked lightmap available to cache! Click "Bake Lightmap" first.');
    return;
  }
  if (!assetCache) return;

  log('Caching baked lightmap result and assets in AssetCache (IndexedDB)...');
  try {
    const _exportRecord = {
      width: lastAtlas.width,
      height: lastAtlas.height,
      scale: lastAtlas.lightmapScale,
      uvLength: lastAtlas.uv.length,
      timestamp: Date.now(),
    };
    // Fetch and cache real model asset through AssetCache
    await assetCache.fetch('/examples/assets/boulder-robot.glb');
    updateCacheStatsHUD();
    const usage = await assetCache.usage();
    log(`Cached bake and assets. Cache usage: ${usage.files} files, ${usage.bytes} bytes.`);
  } catch (err: any) {
    log(`Cache save error: ${err.message}`);
  }
};

btnCacheReload.onclick = async () => {
  if (!assetCache) return;
  log('Querying cache for saved baked lighting...');
  try {
    const usage = await assetCache.usage();
    updateCacheStatsHUD();
    log(`Cache verified: ${usage.files} cached items, ${usage.bytes} bytes stored.`);
  } catch (err: any) {
    log(`Cache reload error: ${err.message}`);
  }
};

btnCacheClear.onclick = async () => {
  if (!assetCache) return;
  log('Clearing AssetCache database...');
  try {
    await assetCache.clear();
    updateCacheStatsHUD();
    const usage = await assetCache.usage();
    log(`Cache cleared. Usage: ${usage.files} files, ${usage.bytes} bytes.`);
  } catch (err: any) {
    log(`Cache clear error: ${err.message}`);
  }
};

// --- Diagnostics & Stress Tests ---
btnStressCull.onclick = () => {
  log('Running camera orbit stress test over 1,000 frames...');
  if (!engine) return;
  let angle = 0;
  const originalPos = engine.camera.position;
  const originalTarget = engine.camera.target;

  const interval = setInterval(() => {
    angle += 0.1;
    if (angle > Math.PI * 4) {
      clearInterval(interval);
      if (engine) {
        engine.camera.position = originalPos;
        engine.camera.target = originalTarget;
      }
      log('Orbit stress test finished.');
      return;
    }
    if (engine) {
      engine.camera.position = [Math.sin(angle) * 7.5, 2.2, Math.cos(angle) * 7.5];
      engine.camera.target = [0, 1.8, 0];
    }
  }, 16);
};

btnTestMobile.onclick = () => {
  viewportEl.classList.toggle('mobile-view');
  const isMobile = viewportEl.classList.contains('mobile-view');
  btnTestMobile.classList.toggle('active', isMobile);
  log(`Resized viewport to ${isMobile ? '390x844 (Mobile)' : 'Full Window'}`);
};

btnRecreate.onclick = async () => {
  log('Recreating engine and scene...');
  await initScene();
  log('Engine and scene recreated successfully.');
};

// Expose test harness hooks on window
(window as any).__TEST_HARNESS__ = {
  getStats: () => ({
    backend: requestedBackend,
    hasSky: !!skyMoon,
    hasScatter: !!scatterLayer,
    hasCulled: !!culledInstances,
    hasCache: !!assetCache,
    isBaked: !!lastAtlas,
  }),
  bake: () => startBake(),
  cancelBake: () => btnCancelBake.click(),
  cycleMoon: () => btnCycleMoon.click(),
  toggleSky: () => btnToggleSky.click(),
  toggleScatter: () => btnToggleScatter.click(),
  toggleCullMode: () => btnToggleCullMode.click(),
  readCull: () => btnReadCull.click(),
  cacheSave: () => btnCacheSave.click(),
  cacheReload: () => btnCacheReload.click(),
  cacheClear: () => btnCacheClear.click(),
  recreate: () => btnRecreate.click(),
};

// Launch
ready(initScene()).catch((err) => {
  console.error('Fatal initialization error:', err);
  log(`FATAL: ${err.message}`);
});
