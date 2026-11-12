// Procedural island test page: stress and edge-case testing for:
// @margoengine/procedural (poisson, dungeon, trees, sdf, textures, buildings, caves, waterfront, cabins)
// @margoengine/biomes, @margoengine/scatter, @margoengine/terrain,
// @margoengine/water, @margoengine/sky, @margoengine/weather,
// using only documented public APIs.
import { ready } from './page-harness';
import { createStage, type Stage, Geometry, type Mesh } from '@margoengine/stage';
import { heightfieldGeometry } from '@margoengine/terrain';
import { TerrainQuery } from '@margoengine/terrain/query';
import {
  createIslandHeight,
  generateCabinMesh,
  generateJettyMesh,
  generateBoatMesh,
  generateRockMesh,
  generateTreeMesh,
  marchingCubes,
} from '@margoengine/procedural';
import { createPoissonSampler } from '@margoengine/procedural/poisson';
import { createDungeonGenerator } from '@margoengine/procedural/dungeon';
import { createTreeGenerator } from '@margoengine/procedural/trees';
import { createSdfModeler } from '@margoengine/procedural/sdf';
import { createBuildingGenerator } from '@margoengine/procedural/buildings';
import { createTextureBaker } from '@margoengine/procedural/textures';
import { BiomeWorld } from '@margoengine/biomes';
import { Water } from '@margoengine/water';
import { Sky } from '@margoengine/sky';
import { WeatherMachine, type WeatherPresetName, hailSettings, skyWeather, windAt } from '@margoengine/weather';
import { Weather } from '@margoengine/sky/weather';
import { Hail } from '@margoengine/weather/hail';
import { install as installWebGL2Compat } from '@margoengine/webgl2-compat';

// In-page logger
const logBox = document.getElementById('logBox')!;
function log(msg: string, type: 'error' | 'warn' | 'info' = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry-${type}`;
  const timestamp = new Date().toISOString().substring(11, 19);
  div.textContent = `[${timestamp}] ${msg}`;
  logBox.prepend(div);
  if (type === 'error') console.error(msg);
  else if (type === 'warn') console.warn(msg);
  else console.log(msg);
}

// Global error capture
window.addEventListener('error', (e) => {
  log(`Uncaught error: ${e.message} at ${e.filename}:${e.lineno}`, 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  log(`Unhandled rejection: ${String(e.reason)}`, 'error');
});

// HUD Elements
const hudFps = document.getElementById('hudFps')!;
const hudFrameTime = document.getElementById('hudFrameTime')!;
const hudMemory = document.getElementById('hudMemory')!;
const hudTriangles = document.getElementById('hudTriangles')!;
const hudGenTotal = document.getElementById('hudGenTotal')!;
const hudPoissonTime = document.getElementById('hudPoissonTime')!;
const hudDungeonTime = document.getElementById('hudDungeonTime')!;
const hudTreesTime = document.getElementById('hudTreesTime')!;
const hudSdfTime = document.getElementById('hudSdfTime')!;
const hudBldgTime = document.getElementById('hudBldgTime')!;
const hudMarchingTime = document.getElementById('hudMarchingTime')!;
const hudBiomeType = document.getElementById('hudBiomeType')!;
const hudElevation = document.getElementById('hudElevation')!;
const hudTemperature = document.getElementById('hudTemperature')!;
const hudRainfall = document.getElementById('hudRainfall')!;
const hudMoisture = document.getElementById('hudMoisture')!;

// Backend detection
const params = new URLSearchParams(location.search);
const isWebgl2 = params.get('backend') === 'webgl2';
const backendBadge = document.getElementById('backendBadge')!;
const btnToggleBackend = document.getElementById('btnToggleBackend') as HTMLAnchorElement;

if (isWebgl2) {
  backendBadge.textContent = 'Backend: WebGL2 Fallback';
  backendBadge.style.color = '#f85149';
  backendBadge.style.borderColor = '#f8514966';
  btnToggleBackend.textContent = 'Switch to WebGPU';
  btnToggleBackend.href = window.location.pathname;
} else {
  backendBadge.textContent = 'Backend: WebGPU (Native)';
  btnToggleBackend.textContent = 'Switch to WebGL2';
  btnToggleBackend.href = '?backend=webgl2';
}

// UI Controls
const rngSeed = document.getElementById('rngSeed') as HTMLInputElement;
const lblSeed = document.getElementById('lblSeed')!;
const rngHours = document.getElementById('rngHours') as HTMLInputElement;
const lblHours = document.getElementById('lblHours')!;
const selWeatherPreset = document.getElementById('selWeatherPreset') as HTMLSelectElement;
const lblWeatherPreset = document.getElementById('lblWeatherPreset')!;

const chkTerrain = document.getElementById('chkTerrain') as HTMLInputElement;
const chkWater = document.getElementById('chkWater') as HTMLInputElement;
const chkSky = document.getElementById('chkSky') as HTMLInputElement;
const chkWeather = document.getElementById('chkWeather') as HTMLInputElement;
const chkPoissonScatter = document.getElementById('chkPoissonScatter') as HTMLInputElement;
const chkSpaceTrees = document.getElementById('chkSpaceTrees') as HTMLInputElement;
const chkDungeon = document.getElementById('chkDungeon') as HTMLInputElement;
const chkMarchingCaves = document.getElementById('chkMarchingCaves') as HTMLInputElement;
const chkSdfMonolith = document.getElementById('chkSdfMonolith') as HTMLInputElement;
const chkBldgs = document.getElementById('chkBldgs') as HTMLInputElement;
const chkWaterfront = document.getElementById('chkWaterfront') as HTMLInputElement;
const chkGpuTextures = document.getElementById('chkGpuTextures') as HTMLInputElement;

// App State
let stage: Stage | null = null;
let currentSeed = 731;
let currentHours = 14.0;
let isDayNightAnimating = false;
let isSeedScrubbing = false;
let terrainQuery: TerrainQuery | null = null;
let biomeWorld: BiomeWorld | null = null;

// Engine Plugins & handles
let _waterPlugin: Water | null = null;
let skyPlugin: Sky | null = null;
let weatherMachine: WeatherMachine | null = null;
let rainPlugin: Weather | null = null;
let hailPlugin: Hail | null = null;

// Mesh trackers for re-generation
const generatedMeshes: Mesh[] = [];

// Helper: Convert GeometryData to core Geometry
function toCoreGeometry(data: {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  indices: ArrayLike<number>;
}): Geometry {
  return new Geometry(data.positions, data.normals, data.indices);
}

// Helper: Compute normals for un-normaled indexed triangles
function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    const ax = positions[i1] - positions[i0];
    const ay = positions[i1 + 1] - positions[i0 + 1];
    const az = positions[i1 + 2] - positions[i0 + 2];
    const bx = positions[i2] - positions[i0];
    const by = positions[i2 + 1] - positions[i0 + 1];
    const bz = positions[i2 + 2] - positions[i0 + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    for (const idx of [i0, i1, i2]) {
      normals[idx] += nx / len;
      normals[idx + 1] += ny / len;
      normals[idx + 2] += nz / len;
    }
  }
  for (let i = 0; i < positions.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }
  return normals;
}

// Initialize or re-create Stage
async function initScene() {
  if (stage) {
    try {
      if (weatherMachine) {
        weatherMachine.dispose();
        weatherMachine = null;
      }
      if (biomeWorld) {
        biomeWorld.dispose();
        biomeWorld = null;
      }
      stage.dispose();
      log('[Lifecycle] Previous Stage and plugins disposed cleanly.', 'info');
    } catch (e) {
      log(`[Lifecycle] Stage disposal error: ${(e as Error).message}`, 'error');
    }
    stage = null;
    _waterPlugin = null;
    skyPlugin = null;
    rainPlugin = null;
    hailPlugin = null;
    generatedMeshes.length = 0;
  }

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  log(`[Init] Creating Stage (backend: ${isWebgl2 ? 'webgl2' : 'auto'})…`, 'info');

  try {
    if (isWebgl2) {
      await installWebGL2Compat({ force: true });
    }
    stage = await createStage(canvas, {
      camera: { position: [0, 48, 85], target: [0, 8, 0], near: 0.1, far: 2000 },
      onError: (err) => log(`Stage engine error: ${String(err)}`, 'error'),
    });
    log('[Init] Stage initialized successfully.', 'info');
  } catch (err) {
    log(`Failed to create Stage: ${(err as Error).message}`, 'error');
    return;
  }

  // Attach Environment / Atmosphere plugins
  setupEnvironmentPlugins();

  // Generate all island procedural content
  await generateIsland(currentSeed);

  // Setup per-frame tick
  stage.onTick((delta) => {
    onFrameTick(delta);
  });
}

function setupEnvironmentPlugins() {
  if (!stage) return;

  // 1. Sky & Sun
  if (chkSky.checked) {
    try {
      skyPlugin = Sky.attach(stage.engine, {
        model: 'bruneton',
        hours: currentHours,
        clouds: { coverage: 0.38, speed: 6 },
      });
      log('[Sky] Bruneton atmospheric sky attached.', 'info');
    } catch (err) {
      log(`[Sky] Sky.attach error: ${(err as Error).message}`, 'error');
    }
  }

  // 2. Water Surface
  if (chkWater.checked) {
    try {
      _waterPlugin = Water.attach(stage.engine, {
        size: [320, 320],
        segments: 128,
        height: 0,
        waves: [
          { direction: [1, 0.25], amplitude: 0.5, wavelength: 28 },
          { direction: [-0.4, 0.9], amplitude: 0.25, wavelength: 14 },
        ],
      });
      log('[Water] Gerstner ocean surface attached at y=0.', 'info');
    } catch (err) {
      log(`[Water] Water.attach error: ${(err as Error).message}`, 'error');
    }
  }

  // 3. Weather Machine & Particle systems
  if (chkWeather.checked) {
    try {
      weatherMachine = new WeatherMachine(selWeatherPreset.value as WeatherPresetName, { seed: currentSeed });
      rainPlugin = Weather.attach(stage.engine, { fadeSeconds: 0, particles: 16000 });
      hailPlugin = Hail.attach(stage.engine, { fadeSeconds: 0, particles: 4000 });
      log(`[Weather] WeatherMachine initialized with preset "${selWeatherPreset.value}".`, 'info');
    } catch (err) {
      log(`[Weather] Weather initialization error: ${(err as Error).message}`, 'error');
    }
  }
}

// Generate all procedural island assets based on seed
let isGenerating = false;
let pendingSeed: number | null = null;

async function generateIsland(seed: number) {
  if (!stage) return;
  if (isGenerating) {
    pendingSeed = seed;
    return;
  }
  isGenerating = true;

  const tStartTotal = performance.now();
  currentSeed = seed;
  lblSeed.textContent = String(seed);

  // Clean up existing generated meshes
  for (const m of generatedMeshes) {
    try {
      m.dispose?.();
    } catch {}
  }
  generatedMeshes.length = 0;

  try {
    // 1. Biomes World
    let biomeSample = null;
    try {
      if (biomeWorld) biomeWorld.dispose();
      biomeWorld = await BiomeWorld.create({ seed });
      biomeSample = biomeWorld.sample(0, 0);
      hudBiomeType.textContent = biomeSample.biomes[0] ?? 'island';
      hudElevation.textContent = `${biomeSample.height.toFixed(1)} m`;
      hudTemperature.textContent = `${biomeSample.temperature.toFixed(1)} °C`;
      hudRainfall.textContent = `${Math.round(biomeSample.rainfall)} mm`;
      hudMoisture.textContent = biomeSample.moisture.toFixed(2);
    } catch (err) {
      log(`[Biomes] BiomeWorld.create error: ${(err as Error).message}`, 'error');
    }

    // 2. Island Heightfield & Terrain
    const ISLAND_SIZE = 140;
    const ISLAND_RES = 71;
    const heightSampler = createIslandHeight(seed);

    if (chkTerrain.checked) {
      const terrainHeights = new Float32Array(ISLAND_RES * ISLAND_RES);
      for (let z = 0; z < ISLAND_RES; z++) {
        for (let x = 0; x < ISLAND_RES; x++) {
          const wx = -ISLAND_SIZE / 2 + (x / (ISLAND_RES - 1)) * ISLAND_SIZE;
          const wz = -ISLAND_SIZE / 2 + (z / (ISLAND_RES - 1)) * ISLAND_SIZE;
          terrainHeights[z * ISLAND_RES + x] = heightSampler(wx, wz);
        }
      }

      terrainQuery = new TerrainQuery(terrainHeights, ISLAND_RES, ISLAND_RES, {
        size: [ISLAND_SIZE, ISLAND_SIZE],
        origin: [-ISLAND_SIZE / 2, -ISLAND_SIZE / 2],
        heightScale: 1,
      });

      const terrainGeomData = heightfieldGeometry((x, z) => terrainQuery?.height(x, z) ?? 0, {
        size: [ISLAND_SIZE, ISLAND_SIZE],
        resolution: ISLAND_RES - 1,
        origin: [-ISLAND_SIZE / 2, -ISLAND_SIZE / 2],
      });

      const terrainMesh = stage.mesh(
        new Geometry(terrainGeomData.positions, terrainGeomData.normals, terrainGeomData.indices),
        {
          color: '#2d4a3e',
          roughness: 0.9,
          metalness: 0.05,
          name: 'IslandTerrain',
        },
      );
      generatedMeshes.push(terrainMesh);
    }

    // 3. Poisson Disk Scatter (Foliage, Rocks, Cabins)
    if (chkPoissonScatter.checked) {
      const t0 = performance.now();
      try {
        const sampler = await createPoissonSampler();
        // Sample points across island interior
        const sampleRect = sampler.rectangle([-45, -45, 45, 45], {
          radius: 6.5,
          seed,
          maxPoints: 80,
        });
        sampler.dispose();

        const tPoisson = performance.now() - t0;
        hudPoissonTime.textContent = `${tPoisson.toFixed(1)} ms`;

        // Generate base props
        const rockGeom = toCoreGeometry(generateRockMesh());
        const conifer = generateTreeMesh('conifer', { detail: 1 });
        const coniferGeom = toCoreGeometry(conifer.canopy);
        const coniferTrunkGeom = toCoreGeometry(conifer.trunk);
        const broadleaf = generateTreeMesh('broadleaf', { detail: 1 });
        const broadleafGeom = toCoreGeometry(broadleaf.canopy);
        const broadleafTrunkGeom = toCoreGeometry(broadleaf.trunk);

        const pts = sampleRect.positions;
        const ptCount = pts.length / 2;

        for (let i = 0; i < ptCount; i++) {
          const px = pts[i * 2];
          const pz = pts[i * 2 + 1];
          const py = terrainQuery ? (terrainQuery.height(px, pz) ?? 0) : heightSampler(px, pz);

          // Only place above sea level
          if (py < 0.5) continue;

          const typeRoll = (seed * 17 + i * 31) % 10;
          if (typeRoll < 4) {
            // Conifer Tree
            const trunkMesh = stage.mesh(coniferTrunkGeom, {
              color: '#4a2f18',
              roughness: 0.95,
              position: [px, py, pz],
              name: `Tree_Trunk_${i}`,
            });
            const canopyMesh = stage.mesh(coniferGeom, {
              color: '#1e4d2b',
              roughness: 0.8,
              position: [px, py, pz],
              name: `Tree_Canopy_${i}`,
            });
            generatedMeshes.push(trunkMesh, canopyMesh);
          } else if (typeRoll < 7) {
            // Broadleaf Tree: the canopy starts about 3.4 m up and sits on its trunk, so both parts are needed.
            const trunkMesh = stage.mesh(broadleafTrunkGeom, {
              color: '#4a2f18',
              roughness: 0.95,
              position: [px, py, pz],
              name: `Broadleaf_Trunk_${i}`,
            });
            const treeMesh = stage.mesh(broadleafGeom, {
              color: '#2e6f40',
              roughness: 0.75,
              position: [px, py, pz],
              name: `Broadleaf_${i}`,
            });
            generatedMeshes.push(trunkMesh, treeMesh);
          } else if (typeRoll < 9) {
            // Rock Boulder
            const rockMesh = stage.mesh(rockGeom, {
              color: '#55585d',
              roughness: 0.85,
              position: [px, py - 0.2, pz],
              scale: [1.4, 1.2, 1.4],
              name: `Rock_${i}`,
            });
            generatedMeshes.push(rockMesh);
          } else if (i === 0) {
            // Timber Cabin nestled on hill
            const cabin = generateCabinMesh(heightSampler, [px, pz]);
            const sidingMesh = stage.mesh(toCoreGeometry(cabin.parts.siding), {
              color: '#654321',
              roughness: 0.85,
              position: [px, cabin.floorElevation, pz],
              name: 'CabinSiding',
            });
            const roofMesh = stage.mesh(toCoreGeometry(cabin.parts.roof), {
              color: '#8b2500',
              roughness: 0.7,
              position: [px, cabin.floorElevation, pz],
              name: 'CabinRoof',
            });
            const foundMesh = stage.mesh(toCoreGeometry(cabin.parts.foundation), {
              color: '#444444',
              roughness: 0.9,
              position: [px, cabin.floorElevation, pz],
              name: 'CabinFoundation',
            });
            generatedMeshes.push(sidingMesh, roofMesh, foundMesh);
          }
        }
      } catch (err) {
        log(`[Poisson] Poisson sampling error: ${(err as Error).message}`, 'error');
      }
    }

    // 4. Space Colonization Tree (@margoengine/procedural/trees)
    if (chkSpaceTrees.checked) {
      const t0 = performance.now();
      try {
        const treeGen = await createTreeGenerator();
        const treeData = treeGen.generate({
          seed,
          root: [15, terrainQuery ? (terrainQuery.height(15, 10) ?? 0) : 5, 10],
          attractionCount: 384,
          segmentLength: 0.35,
          influenceRadius: 3.5,
          maxNodes: 1024,
        });
        treeGen.dispose();

        const tTree = performance.now() - t0;
        hudTreesTime.textContent = `${tTree.toFixed(1)} ms`;

        // Build tubular segments along branch parents
        const positions = treeData.positions;
        const parents = treeData.parents;
        const nodeCount = positions.length / 3;

        // Render branching nodes as small connected spheres / segments
        for (let i = 1; i < nodeCount; i += 4) {
          const pIdx = parents[i];
          if (pIdx < 0) continue;
          const x = positions[i * 3];
          const y = positions[i * 3 + 1];
          const z = positions[i * 3 + 2];
          const px = positions[pIdx * 3];
          const py = positions[pIdx * 3 + 1];
          const pz = positions[pIdx * 3 + 2];
          const midX = (x + px) / 2;
          const midY = (y + py) / 2;
          const midZ = (z + pz) / 2;
          const len = Math.hypot(x - px, y - py, z - pz);

          const branch = stage.box({
            size: [0.18, len, 0.18],
            color: '#3d2616',
            roughness: 0.9,
            position: [midX, midY, midZ],
            name: `ColonizationBranch_${i}`,
          });
          generatedMeshes.push(branch);
        }
      } catch (err) {
        log(`[Trees] Space tree generator error: ${(err as Error).message}`, 'error');
      }
    }

    // 5. Underground Dungeon / Cave (@margoengine/procedural/dungeon)
    if (chkDungeon.checked) {
      const t0 = performance.now();
      try {
        const dungeonGen = await createDungeonGenerator();
        const dungeon = dungeonGen.generate({
          width: 24,
          height: 24,
          seed,
          minRoomSize: 3,
          maxRooms: 12,
        });
        dungeonGen.dispose();

        const tDungeon = performance.now() - t0;
        hudDungeonTime.textContent = `${tDungeon.toFixed(1)} ms`;

        // Render dungeon floor slabs at Y = -18 (underground)
        const DUNGEON_Y = -18;
        for (const room of dungeon.rooms) {
          const rx = room.x - 12;
          const rz = room.y - 12;
          const roomMesh = stage.box({
            size: [room.width * 1.5, 0.4, room.height * 1.5],
            color: '#3a3335',
            roughness: 0.95,
            position: [rx * 1.5 + (room.width * 1.5) / 2, DUNGEON_Y, rz * 1.5 + (room.height * 1.5) / 2],
            name: `DungeonRoom_${room.x}_${room.y}`,
          });
          generatedMeshes.push(roomMesh);
        }
      } catch (err) {
        log(`[Dungeon] Dungeon generator error: ${(err as Error).message}`, 'error');
      }
    }

    // 6. Coastal Cave / Grotto (Marching Cubes)
    if (chkMarchingCaves.checked) {
      const t0 = performance.now();
      try {
        // Cut a grotto cavity into coastal cliff side
        const caveGeom = marchingCubes(
          (x, y, z) => {
            const sphereDist = Math.hypot(x, y, z) - 3.8;
            const noiseRipple = Math.sin(x * 1.8) * Math.cos(z * 1.8) * 0.4;
            return sphereDist + noiseRipple;
          },
          {
            resolution: [20, 20, 20],
            bounds: [
              [-4.5, -4.5, -4.5],
              [4.5, 4.5, 4.5],
            ],
          },
        );

        const tMarching = performance.now() - t0;
        hudMarchingTime.textContent = `${tMarching.toFixed(1)} ms`;

        if (caveGeom) {
          const count = caveGeom.vertices.length / 6;
          const positions = new Float32Array(count * 3);
          const normals = new Float32Array(count * 3);
          for (let i = 0; i < count; i++) {
            positions[i * 3] = caveGeom.vertices[i * 6];
            positions[i * 3 + 1] = caveGeom.vertices[i * 6 + 1];
            positions[i * 3 + 2] = caveGeom.vertices[i * 6 + 2];
            normals[i * 3] = caveGeom.vertices[i * 6 + 3];
            normals[i * 3 + 1] = caveGeom.vertices[i * 6 + 4];
            normals[i * 3 + 2] = caveGeom.vertices[i * 6 + 5];
          }
          const caveMesh = stage.mesh(new Geometry(positions, normals, caveGeom.indices), {
            color: '#282b30',
            roughness: 0.9,
            position: [-28, 2.5, 12],
            name: 'CoastalGrotto',
          });
          generatedMeshes.push(caveMesh);
        }
      } catch (err) {
        log(`[MarchingCubes] Cave extraction error: ${(err as Error).message}`, 'error');
      }
    }

    // 7. Sharp SDF CSG Monument (@margoengine/procedural/sdf)
    if (chkSdfMonolith.checked) {
      const t0 = performance.now();
      try {
        const sdfModeler = await createSdfModeler();
        const csgMesh = sdfModeler.mesh(
          {
            type: 'difference',
            a: { type: 'box', halfSize: [1.8, 2.8, 1.8] },
            b: { type: 'sphere', center: [0.6, 0.5, 0.6], radius: 1.4 },
          },
          { resolution: 24 },
        );
        sdfModeler.dispose();

        const tSdf = performance.now() - t0;
        hudSdfTime.textContent = `${tSdf.toFixed(1)} ms`;

        const posF32 = new Float32Array(csgMesh.positions);
        const normF32 = computeNormals(posF32, csgMesh.indices);
        const monolith = stage.mesh(new Geometry(posF32, normF32, csgMesh.indices), {
          color: '#8b8000',
          roughness: 0.25,
          metalness: 0.7,
          position: [0, (terrainQuery?.height(0, -18) ?? 12) + 2.8, -18],
          name: 'SdfMonument',
        });
        generatedMeshes.push(monolith);
      } catch (err) {
        log(`[SDF] Dual contouring error: ${(err as Error).message}`, 'error');
      }
    }

    // 8. Rectangular Grammar Building (@margoengine/procedural/buildings)
    if (chkBldgs.checked) {
      const t0 = performance.now();
      try {
        const bldgGen = await createBuildingGenerator();
        const bldgMesh = bldgGen.generate({
          width: 16,
          depth: 10,
          floorHeights: [3.8, 3.2, 3.2],
          bayWidth: 3.2,
          window: [0.6, 0.65],
          roof: 'gable',
          roofHeight: 2.5,
        });
        bldgGen.dispose();

        const tBldg = performance.now() - t0;
        hudBldgTime.textContent = `${tBldg.toFixed(1)} ms`;

        const posF32 = new Float32Array(bldgMesh.positions);
        const bldg = stage.mesh(new Geometry(posF32, bldgMesh.normals, bldgMesh.indices), {
          color: '#c2b2a3',
          roughness: 0.85,
          position: [-16, terrainQuery?.height(-16, -5) ?? 6, -5],
          name: 'GrammarBuilding',
        });
        generatedMeshes.push(bldg);
      } catch (err) {
        log(`[Buildings] Building grammar error: ${(err as Error).message}`, 'error');
      }
    }

    // 9. Waterfront Jetty & Boat
    if (chkWaterfront.checked) {
      try {
        const jetty = generateJettyMesh({ length: 22, width: 2.4, height: 1.1, seed });
        const boat = generateBoatMesh({ length: 3.8, seats: 3, oars: true, seed });

        const jettyMesh = stage.mesh(toCoreGeometry(jetty), {
          color: '#5c4033',
          roughness: 0.9,
          position: [24, 0, 18],
          name: 'WaterfrontJetty',
        });
        const boatMesh = stage.mesh(toCoreGeometry(boat), {
          color: '#8b0000',
          roughness: 0.5,
          position: [32, 0, 22],
          name: 'MooredBoat',
        });
        generatedMeshes.push(jettyMesh, boatMesh);
      } catch (err) {
        log(`[Waterfront] Jetty / Boat generation error: ${(err as Error).message}`, 'error');
      }
    }

    // 10. GPU Texture Baker (@margoengine/procedural/textures)
    if (chkGpuTextures.checked) {
      try {
        const gpuDevice = (stage.engine as unknown as { gpu?: GPUDevice }).gpu;
        if (!isWebgl2 && gpuDevice) {
          const baker = await createTextureBaker(gpuDevice);
          const baked = await baker.bake({ pattern: 'bricks', width: 256, height: 256, seed });
          log(
            `[Textures] GPU compute baked brick texture: format=${baked.texture.format}, ${baked.width}x${baked.height}`,
            'info',
          );
          baker.dispose();
        } else if (isWebgl2) {
          log(
            '[Textures] WebGL2 compatibility tier detected: GPU texture baker correctly refused (unsupported).',
            'info',
          );
        }
      } catch (err) {
        log(`[Textures] GPU texture baker error: ${(err as Error).message}`, isWebgl2 ? 'info' : 'error');
      }
    }

    const totalMs = performance.now() - tStartTotal;
    hudGenTotal.textContent = `${totalMs.toFixed(0)} ms`;
    log(
      `[Gen] Island generated for seed ${seed} in ${totalMs.toFixed(1)} ms. (${generatedMeshes.length} meshes created)`,
      'info',
    );
  } catch (err) {
    log(`[Gen] Critical failure in island generation: ${(err as Error).message}`, 'error');
  } finally {
    isGenerating = false;
    if (pendingSeed !== null) {
      const s = pendingSeed;
      pendingSeed = null;
      generateIsland(s);
    }
  }
}

// Per-frame Tick & Telemetry
let lastFrameTime = performance.now();
let frameCount = 0;
let lastFpsUpdate = performance.now();

function onFrameTick(delta: number) {
  const now = performance.now();
  const frameMs = now - lastFrameTime;
  lastFrameTime = now;
  frameCount++;

  // Update telemetry HUD every 250 ms
  if (now - lastFpsUpdate >= 250) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    hudFps.textContent = String(fps);
    hudFrameTime.textContent = `${frameMs.toFixed(1)} ms`;
    frameCount = 0;
    lastFpsUpdate = now;

    // Memory tracking
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    if (mem?.usedJSHeapSize) {
      hudMemory.textContent = `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB`;
    }

    // Triangle counting
    let totalTris = 0;
    for (const m of generatedMeshes) {
      if (m?.geometry?.indices) {
        totalTris += m.geometry.indices.length / 3;
      }
    }
    hudTriangles.textContent = totalTris.toLocaleString('en');
  }

  // 1. Dynamic Day & Night Cycle Animation (60 FPS)
  if (isDayNightAnimating && skyPlugin) {
    currentHours = (currentHours + delta * 2.0) % 24;
    rngHours.value = currentHours.toFixed(1);
    lblHours.textContent = `${currentHours.toFixed(1)} h`;
    skyPlugin.options.hours = currentHours;
  }

  // 2. Weather Machine Frame Step
  if (weatherMachine && rainPlugin && hailPlugin) {
    try {
      const state = weatherMachine.update(delta);
      const wind = windAt(weatherMachine.wind, 0, 10, 0, weatherMachine.time);
      Object.assign(rainPlugin.options, skyWeather(state, wind));
      Object.assign(hailPlugin.options, hailSettings(state, wind));
    } catch (err) {
      log(`Weather update frame error: ${(err as Error).message}`, 'error');
    }
  }
}

// Wire Event Listeners & UI Controls
function setupUI() {
  // Seed Slider
  rngSeed.addEventListener('input', () => {
    const val = Number(rngSeed.value);
    lblSeed.textContent = String(val);
    generateIsland(val);
  });

  document.getElementById('btnRandomSeed')!.addEventListener('click', () => {
    const val = Math.floor(Math.random() * 1000) + 1;
    rngSeed.value = String(val);
    lblSeed.textContent = String(val);
    generateIsland(val);
  });

  // Rapid Seed Scrubbing Stress Test
  const btnRapidSeedScrub = document.getElementById('btnRapidSeedScrub')!;
  btnRapidSeedScrub.addEventListener('click', async () => {
    if (isSeedScrubbing) return;
    isSeedScrubbing = true;
    log('[Stress] Starting rapid seed scrubbing (25 seed changes in 1.5 seconds)…', 'info');
    for (let i = 0; i < 25; i++) {
      const s = ((currentSeed + i * 37) % 1000) + 1;
      rngSeed.value = String(s);
      generateIsland(s);
      await new Promise((r) => setTimeout(r, 60));
    }
    isSeedScrubbing = false;
    log('[Stress] Rapid seed scrubbing finished.', 'info');
  });

  // Day/Night Cycle Slider
  rngHours.addEventListener('input', () => {
    currentHours = Number(rngHours.value);
    lblHours.textContent = `${currentHours.toFixed(1)} h`;
    if (skyPlugin) {
      skyPlugin.options.hours = currentHours;
    }
  });

  const btnToggleDayNightCycle = document.getElementById('btnToggleDayNightCycle')!;
  btnToggleDayNightCycle.addEventListener('click', () => {
    isDayNightAnimating = !isDayNightAnimating;
    btnToggleDayNightCycle.classList.toggle('active', isDayNightAnimating);
    log(`[Sky] 24h Day/Night cycle animation: ${isDayNightAnimating}`, 'info');
  });

  document.getElementById('btnSkyNoon')!.addEventListener('click', () => {
    currentHours = 12.0;
    rngHours.value = '12.0';
    lblHours.textContent = '12.0 h';
    if (skyPlugin) skyPlugin.options.hours = 12.0;
  });

  document.getElementById('btnSkySunset')!.addEventListener('click', () => {
    currentHours = 18.5;
    rngHours.value = '18.5';
    lblHours.textContent = '18.5 h';
    if (skyPlugin) skyPlugin.options.hours = 18.5;
  });

  document.getElementById('btnSkyMidnight')!.addEventListener('click', () => {
    currentHours = 0.0;
    rngHours.value = '0.0';
    lblHours.textContent = '0.0 h';
    if (skyPlugin) skyPlugin.options.hours = 0.0;
  });

  // Weather Preset Selector
  selWeatherPreset.addEventListener('change', () => {
    const preset = selWeatherPreset.value as WeatherPresetName;
    lblWeatherPreset.textContent = preset;
    if (weatherMachine) {
      weatherMachine.transitionTo(preset, { seconds: 4 });
      log(`[Weather] Transitioning to preset "${preset}" over 4 s.`, 'info');
    }
  });

  // Rapid Weather Preset Cycling
  document.getElementById('btnWeatherRapidCycle')!.addEventListener('click', async () => {
    const presets: WeatherPresetName[] = ['clear', 'rain', 'thunderstorm', 'fog', 'snow', 'blizzard', 'hail', 'clear'];
    log('[Stress] Rapidly switching through 8 weather states…', 'info');
    for (const p of presets) {
      selWeatherPreset.value = p;
      lblWeatherPreset.textContent = p;
      if (weatherMachine) weatherMachine.transitionTo(p, { seconds: 0.5 });
      await new Promise((r) => setTimeout(r, 600));
    }
    log('[Stress] Weather cycling complete.', 'info');
  });

  // Feature Checkbox Toggles
  const featureCheckboxes = [
    chkTerrain,
    chkWater,
    chkSky,
    chkWeather,
    chkPoissonScatter,
    chkSpaceTrees,
    chkDungeon,
    chkMarchingCaves,
    chkSdfMonolith,
    chkBldgs,
    chkWaterfront,
    chkGpuTextures,
  ];
  for (const cb of featureCheckboxes) {
    cb.addEventListener('change', () => {
      log(`[Toggle] Feature ${cb.id} set to ${cb.checked}`, 'info');
      initScene();
    });
  }

  // 390px Mobile Viewport Resize
  const viewportWrapper = document.getElementById('viewportWrapper')!;
  const btnResizeMobile = document.getElementById('btnResizeMobile')!;
  btnResizeMobile.addEventListener('click', () => {
    viewportWrapper.classList.toggle('mobile-view');
    const isMobile = viewportWrapper.classList.contains('mobile-view');
    btnResizeMobile.textContent = isMobile ? 'Restore Viewport (100%)' : 'Toggle 390px Mobile View';
    btnResizeMobile.classList.toggle('active', isMobile);
    log(`[Stress] Viewport resized to ${isMobile ? '390px (Mobile)' : '100%'}`, 'info');
  });

  // Simulate Focus Loss and Restore
  document.getElementById('btnSimulateFocusLoss')!.addEventListener('click', () => {
    log('[Stress] Simulating window blur / focus loss…', 'info');
    window.dispatchEvent(new Event('blur'));
    setTimeout(() => {
      log('[Stress] Simulating window focus restore…', 'info');
      window.dispatchEvent(new Event('focus'));
    }, 800);
  });

  // Re-create Scene from scratch
  document.getElementById('btnRecreateScene')!.addEventListener('click', () => {
    log('[Stress] Full Scene Disposal and Re-creation requested…', 'info');
    initScene();
  });
}

// Start
setupUI();
ready(initScene());
