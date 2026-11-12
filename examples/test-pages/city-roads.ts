// City roads test page: stress and edge-case testing for @margoengine/road,
// @margoengine/terrain, and @margoengine/splines using only public APIs.
import { ready } from './page-harness';
import { createStage, type Stage, Geometry, type Mesh } from '@margoengine/stage';
import { road } from '@margoengine/road';
import { Spline } from '@margoengine/splines';
import { heightfieldGeometry } from '@margoengine/terrain';
import { TerrainQuery } from '@margoengine/terrain/query';
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
const hudRoads = document.getElementById('hudRoads')!;
const hudCarDist = document.getElementById('hudCarDist')!;
const shortestPathInfo = document.getElementById('shortestPathInfo')!;

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

// Network Topology: 5 Junction Nodes
interface JunctionNode {
  id: string;
  pos: [number, number, number];
}

const NODES: JunctionNode[] = [
  { id: 'A', pos: [-35, 0, -25] },
  { id: 'B', pos: [0, 0, -20] },
  { id: 'C', pos: [35, 0, -15] },
  { id: 'D', pos: [30, 0, 25] },
  { id: 'E', pos: [-25, 0, 25] },
];

interface RoadEdge {
  from: string;
  to: string;
  spline: Spline;
  meshHandle: Mesh;
  speedLimit: number;
  isClosed?: boolean;
}

// App State
let stage: Stage | null = null;
let terrainQuery: TerrainQuery | null = null;
let edges: RoadEdge[] = [];
let carMesh: Mesh | null = null;
let currentPath: RoadEdge[] = [];
let currentPathIndex = 0;
let carDistanceAlongEdge = 0;
let carSpeed = 25; // m/s
let isRoadblockActive = false;
let isStressAnimating = false;
let isClosedLoopActive = false;

// Geometry configuration
let roadWidth = 6;
let roadSegments = 128;
let bankingDeg = 0;
let fitToTerrain = true;

// Terrain dimensions
const TERRAIN_RES = 65;
const TERRAIN_SIZE = 120;
const TERRAIN_ORIGIN = -60;
let terrainHeights: Float32Array;

function buildTerrainHeights(): Float32Array {
  const heights = new Float32Array(TERRAIN_RES * TERRAIN_RES);
  for (let z = 0; z < TERRAIN_RES; z++) {
    for (let x = 0; x < TERRAIN_RES; x++) {
      const wx = TERRAIN_ORIGIN + (x / (TERRAIN_RES - 1)) * TERRAIN_SIZE;
      const wz = TERRAIN_ORIGIN + (z / (TERRAIN_RES - 1)) * TERRAIN_SIZE;
      // Rolling landscape with hills and valley
      heights[z * TERRAIN_RES + x] = Math.sin(wx / 16) * Math.cos(wz / 16) * 4.5 + Math.sin(wx / 8) * 1.5;
    }
  }
  return heights;
}

function sampleTerrain(x: number, z: number): number {
  if (!terrainQuery || !fitToTerrain) return 0;
  return terrainQuery.height(x, z) ?? 0;
}

// Custom cross section with banking support
function getCrossSection(width: number, bankingAngleDeg: number): [number, number][] {
  const curbW = 0.25;
  const curbH = 0.18;
  const rad = (bankingAngleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const flatSection: [number, number][] = [
    [-width / 2 - curbW, 0],
    [-width / 2 - curbW, curbH],
    [-width / 2, curbH],
    [-width / 2, 0],
    [width / 2, 0],
    [width / 2, curbH],
    [width / 2 + curbW, curbH],
    [width / 2 + curbW, 0],
  ];

  if (Math.abs(bankingAngleDeg) < 0.01) return flatSection;

  // Attempt to bank by rotating crossSection points
  return flatSection.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
}

// True while a test deliberately builds a road the package documents as refused.
let expectRefusal = false;
const coded = (err: unknown) => typeof (err as { code?: unknown })?.code === 'string';

// Create road geometry from spline
function createRoadGeometry(curve: Spline): { geometry: Geometry; uvs: Float32Array } {
  try {
    const crossSection = getCrossSection(roadWidth, bankingDeg);
    const result = road(curve, {
      width: roadWidth,
      curbWidth: 0.25,
      curbHeight: 0.18,
      segments: roadSegments,
      crossSection,
    });
    return result;
  } catch (err) {
    log(`road() threw error: ${(err as Error).message}`, expectRefusal && coded(err) ? 'info' : 'error');
    throw err;
  }
}

// Setup or re-create entire stage
async function initScene() {
  if (stage) {
    try {
      stage.dispose();
      log('[Lifecycle] Previous stage disposed cleanly.', 'info');
    } catch (e) {
      log(`[Lifecycle] stage.dispose() error: ${(e as Error).message}`, 'error');
    }
    stage = null;
    edges = [];
  }

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  log(`[Init] Creating Stage with backend: ${isWebgl2 ? 'webgl2' : 'auto'}…`, 'info');

  try {
    if (isWebgl2) {
      await installWebGL2Compat({ force: true });
    }
    stage = await createStage(canvas, {
      camera: { position: [0, 45, 60], target: [0, 0, 0] },
      onError: (err) => log(`Stage engine error: ${String(err)}`, 'error'),
    });
    log('[Init] Stage initialized successfully.', 'info');
  } catch (err) {
    log(`Failed to create stage: ${(err as Error).message}`, 'error');
    return;
  }

  // 1. Build Terrain
  terrainHeights = buildTerrainHeights();
  terrainQuery = new TerrainQuery(terrainHeights, TERRAIN_RES, TERRAIN_RES, {
    size: [TERRAIN_SIZE, TERRAIN_SIZE],
    origin: [TERRAIN_ORIGIN, TERRAIN_ORIGIN],
    heightScale: 1,
  });

  const terrainData = heightfieldGeometry((x, z) => sampleTerrain(x, z), {
    size: [TERRAIN_SIZE, TERRAIN_SIZE],
    resolution: TERRAIN_RES - 1,
    origin: [TERRAIN_ORIGIN, TERRAIN_ORIGIN],
  });

  const terrainGeom = new Geometry(terrainData.positions, terrainData.normals, terrainData.indices);

  stage.mesh(terrainGeom, {
    color: '#1e3328',
    roughness: 0.95,
    metalness: 0.05,
    name: 'Terrain',
  });

  // 2. Build Road Network Edges
  buildRoadNetwork();

  // 3. Create Car Mesh (Yellow Box)
  carMesh = stage.box({
    size: [2.2, 1.2, 4.0],
    color: '#ffc107',
    roughness: 0.3,
    metalness: 0.4,
    position: [0, 0, 0],
    name: 'Car',
  });

  // 4. Compute Initial Shortest Path
  computeShortestPath();

  // 5. Setup Tick Loop
  stage.onTick((delta) => {
    onFrameTick(delta);
  });
}

function buildRoadNetwork() {
  if (!stage) return;
  edges = [];

  // Update Node Y based on terrain height
  for (const node of NODES) {
    node.pos[1] = sampleTerrain(node.pos[0], node.pos[2]);
  }

  const getNode = (id: string) => NODES.find((n) => n.id === id)!.pos;

  // Edge definitions: [from, to, midpoints, speedLimit, isClosed?]
  const edgeDefs: [string, string, [number, number, number][], number, boolean?][] = [
    ['A', 'B', [[-18, sampleTerrain(-18, -22), -22]], 30],
    ['B', 'C', [[18, sampleTerrain(18, -17), -17]], 40],
    ['C', 'D', [[36, sampleTerrain(36, 5), 5]], 25],
    ['D', 'E', [[0, sampleTerrain(0, 27), 27]], 35],
    ['B', 'E', [[-10, sampleTerrain(-10, 2), 2]], 20],
  ];

  if (isClosedLoopActive) {
    edgeDefs.push(['E', 'A', [[-34, sampleTerrain(-34, 0), 0]], 25, true]);
  }

  for (const [from, to, mids, speed, isClosed] of edgeDefs) {
    const pStart = getNode(from);
    const pEnd = getNode(to);
    const waypoints: [number, number, number][] = [pStart, ...mids, pEnd];

    try {
      const spline = new Spline(waypoints, { closed: !!isClosed });
      const { geometry } = createRoadGeometry(spline);
      const meshHandle = stage.mesh(geometry, {
        color: '#2a2d34',
        roughness: 0.85,
        metalness: 0.1,
        name: `Road_${from}_${to}`,
      });

      edges.push({
        from,
        to,
        spline,
        meshHandle,
        speedLimit: speed,
        isClosed,
      });
    } catch (err) {
      log(`Failed to create road ${from}->${to}: ${(err as Error).message}`, 'error');
    }
  }

  hudRoads.textContent = `${edges.length} segments`;
}

// Shortest Path Routing (Dijkstra on travel-time graph: weight = length / speed)
function computeShortestPath() {
  const startNode = 'A';
  const goalNode = 'D';

  const dist: Record<string, number> = {};
  const prev: Record<string, { node: string; edge: RoadEdge } | null> = {};
  const unvisited = new Set<string>();

  for (const n of NODES) {
    dist[n.id] = Infinity;
    prev[n.id] = null;
    unvisited.add(n.id);
  }
  dist[startNode] = 0;

  while (unvisited.size > 0) {
    let curr: string | null = null;
    let minD = Infinity;
    for (const u of unvisited) {
      if (dist[u] < minD) {
        minD = dist[u];
        curr = u;
      }
    }
    if (!curr || minD === Infinity || curr === goalNode) break;
    unvisited.delete(curr);

    for (const edge of edges) {
      if (isRoadblockActive && edge.from === 'B' && edge.to === 'E') continue;

      let neighbor: string | null = null;
      if (edge.from === curr) neighbor = edge.to;
      else if (edge.to === curr && !edge.isClosed) neighbor = edge.from;

      if (neighbor && unvisited.has(neighbor)) {
        const travelTime = edge.spline.length / edge.speedLimit;
        const alt = dist[curr] + travelTime;
        if (alt < dist[neighbor]) {
          dist[neighbor] = alt;
          prev[neighbor] = { node: curr, edge };
        }
      }
    }
  }

  const path: RoadEdge[] = [];
  let curr: string | null = goalNode;
  const pathNodes: string[] = [goalNode];

  while (curr && prev[curr]) {
    const step: { node: string; edge: RoadEdge } = prev[curr]!;
    path.unshift(step.edge);
    curr = step.node;
    pathNodes.unshift(curr);
  }

  if (path.length > 0 && pathNodes[0] === startNode) {
    currentPath = path;
    currentPathIndex = 0;
    carDistanceAlongEdge = 0;
    const totalDist = path.reduce((sum, e) => sum + e.spline.length, 0);
    shortestPathInfo.textContent = `${pathNodes.join(' → ')} (${totalDist.toFixed(1)} m, time ${(dist[goalNode]).toFixed(1)} s)`;
    log(`[Routing] Shortest path computed: ${pathNodes.join(' → ')} (time ${dist[goalNode].toFixed(1)} s)`, 'info');
  } else {
    currentPath = [];
    shortestPathInfo.textContent = 'No route available!';
    log('[Routing] No path found from start to goal!', 'warn');
  }
}

// Animation & Frame Metrics
let lastFrameTime = performance.now();
let frameCount = 0;
let lastFpsUpdate = performance.now();
const carPosBuf = new Float64Array(3);
const carTangBuf = new Float64Array(3);

function onFrameTick(delta: number) {
  const now = performance.now();
  const frameMs = now - lastFrameTime;
  lastFrameTime = now;
  frameCount++;

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

    let totalTris = 0;
    for (const edge of edges) {
      if (edge.meshHandle?.geometry?.indices) {
        totalTris += edge.meshHandle.geometry.indices.length / 3;
      }
    }
    hudTriangles.textContent = totalTris.toLocaleString('en');
  }

  // 1. Move Car along Shortest Path
  if (currentPath.length > 0 && carMesh) {
    const currentEdge = currentPath[currentPathIndex];
    carDistanceAlongEdge += carSpeed * delta;

    if (carDistanceAlongEdge >= currentEdge.spline.length) {
      carDistanceAlongEdge = 0;
      currentPathIndex = (currentPathIndex + 1) % currentPath.length;
    }

    const curve = currentEdge.spline;
    curve.atDistance(carDistanceAlongEdge, carPosBuf);
    curve.tangent(carDistanceAlongEdge / curve.length, carTangBuf);

    carMesh.position.set(carPosBuf[0], carPosBuf[1] + 0.65, carPosBuf[2]);
    const yaw = Math.atan2(carTangBuf[0], carTangBuf[2]);
    carMesh.rotation.set(0, yaw, 0);

    hudCarDist.textContent = `${carDistanceAlongEdge.toFixed(1)} / ${curve.length.toFixed(1)} m`;
  }

  // 2. Stress Test: Continuous 60 FPS Knot Animation
  if (isStressAnimating) {
    const t = now * 0.002;
    NODES[1].pos[0] = Math.sin(t) * 12;
    NODES[1].pos[2] = -20 + Math.cos(t * 1.3) * 8;
    NODES[1].pos[1] = sampleTerrain(NODES[1].pos[0], NODES[1].pos[2]);

    updateAffectedEdges(['B']);
  }
}

function updateAffectedEdges(affectedNodeIds: string[]) {
  for (const edge of edges) {
    if (affectedNodeIds.includes(edge.from) || affectedNodeIds.includes(edge.to)) {
      const pStart = NODES.find((n) => n.id === edge.from)!.pos;
      const pEnd = NODES.find((n) => n.id === edge.to)!.pos;

      // Update start knot in flat Float64Array
      edge.spline.points[0] = pStart[0];
      edge.spline.points[1] = pStart[1];
      edge.spline.points[2] = pStart[2];

      // Update midpoint if exists
      if (edge.spline.points.length >= 9) {
        const mx = edge.spline.points[3];
        const mz = edge.spline.points[5];
        edge.spline.points[4] = sampleTerrain(mx, mz);
      }

      // Update end knot
      const endOffset = edge.spline.points.length - 3;
      edge.spline.points[endOffset] = pEnd[0];
      edge.spline.points[endOffset + 1] = pEnd[1];
      edge.spline.points[endOffset + 2] = pEnd[2];

      edge.spline.updateArcLengths();

      try {
        const { geometry } = createRoadGeometry(edge.spline);
        edge.meshHandle.setGeometry(geometry);
      } catch (err) {
        log(
          `Geometry update error on ${edge.from}->${edge.to}: ${(err as Error).message}`,
          expectRefusal && coded(err) ? 'info' : 'error',
        );
      }
    }
  }
}

// Setup Event Listeners
function setupControls() {
  const knotSelect = document.getElementById('knotSelect') as HTMLSelectElement;
  const knotXRange = document.getElementById('knotXRange') as HTMLInputElement;
  const knotZRange = document.getElementById('knotZRange') as HTMLInputElement;
  const knotXVal = document.getElementById('knotXVal')!;
  const knotZVal = document.getElementById('knotZVal')!;

  const updateSelectedKnot = () => {
    const idx = Number(knotSelect.value);
    const node = NODES[idx];
    const dx = Number(knotXRange.value);
    const dz = Number(knotZRange.value);
    knotXVal.textContent = `${dx} m`;
    knotZVal.textContent = `${dz} m`;

    node.pos[0] += dx * 0.1;
    node.pos[2] += dz * 0.1;
    node.pos[1] = sampleTerrain(node.pos[0], node.pos[2]);

    updateAffectedEdges([node.id]);
    computeShortestPath();
  };

  knotXRange.addEventListener('input', updateSelectedKnot);
  knotZRange.addEventListener('input', updateSelectedKnot);

  document.getElementById('btnCloseLoop')!.addEventListener('click', () => {
    isClosedLoopActive = !isClosedLoopActive;
    log(`[Test] Loop closure toggled: ${isClosedLoopActive}`, 'info');
    buildRoadNetwork();
    computeShortestPath();

    const loopEdge = edges.find((e) => e.isClosed);
    if (loopEdge) {
      const geom = loopEdge.meshHandle.geometry;
      if (!geom) return;
      const v = geom.vertices;
      // Bug 1: a closed road's last section must meet its first. Find the nearest vertex in the second half of the
      // sweep to vertex 0 (the first section's left edge).
      const count = v.length / 6;
      let dist = Infinity;
      for (let i = Math.ceil(count / 2); i < count; i++)
        dist = Math.min(dist, Math.hypot(v[0] - v[i * 6], v[1] - v[i * 6 + 1], v[2] - v[i * 6 + 2]));
      if (dist > 0.001) {
        log(
          `BUG DETECTED: Closed road loop has open seam! Vertex gap at junction = ${dist.toFixed(4)} m. Road geometry does not weld start and end vertices.`,
          'warn',
        );
      }
    }
  });

  document.getElementById('btnSharpBend')!.addEventListener('click', () => {
    log('[Test] Applying extreme sharp hairpin bend (radius -> 0)…', 'info');
    NODES[1].pos[0] = NODES[0].pos[0] + 0.1;
    NODES[1].pos[2] = NODES[0].pos[2] + 0.1;
    // Bug 6: a bend this tight is a cusp; road() rejects it with a coded error (packages/road/README.md).
    expectRefusal = true;
    try {
      updateAffectedEdges(['B']);
    } finally {
      expectRefusal = false;
    }
  });

  document.getElementById('btnVerticalTangent')!.addEventListener('click', () => {
    log('[Test] Triggering vertical tangent on road spline (p1 directly above p0)…', 'info');
    try {
      const vertSpline = new Spline([
        [0, 0, 0],
        [0, 20, 0],
        [0, 40, 0],
      ]);
      road(vertSpline);
      log('road() accepted a vertical tangent; the README says it rejects one with code unsupported', 'error');
    } catch (e) {
      // Bug 2: documented refusal (packages/road/README.md, "Vertical tangents reject with linked code unsupported").
      log(`road() refused the vertical tangent as documented: ${(e as Error).message}`, coded(e) ? 'info' : 'error');
    }
  });

  document.getElementById('btnZeroLength')!.addEventListener('click', () => {
    log('[Test] Passing duplicate consecutive knots (length = 0)…', 'info');
    try {
      const dupSpline = new Spline([
        [0, 0, 0],
        [0, 0, 0],
        [10, 0, 0],
      ]);
      const res = road(dupSpline);
      log(`Duplicate knot handled without crash. Vertices generated: ${res.geometry.vertices.length / 6}`, 'info');
    } catch (e) {
      // Duplicate knots make a cusp, which road() rejects with a coded error (packages/road/README.md).
      log(`road() refused duplicate knots as documented: ${(e as Error).message}`, coded(e) ? 'info' : 'error');
    }
  });

  const widthRange = document.getElementById('widthRange') as HTMLInputElement;
  const segmentsRange = document.getElementById('segmentsRange') as HTMLInputElement;
  const bankingRange = document.getElementById('bankingRange') as HTMLInputElement;

  widthRange.addEventListener('input', () => {
    roadWidth = Number(widthRange.value);
    document.getElementById('widthVal')!.textContent = `${roadWidth} m`;
    updateAffectedEdges(['A', 'B', 'C', 'D', 'E']);
  });

  segmentsRange.addEventListener('input', () => {
    roadSegments = Number(segmentsRange.value);
    document.getElementById('segmentsVal')!.textContent = String(roadSegments);
    updateAffectedEdges(['A', 'B', 'C', 'D', 'E']);
  });

  bankingRange.addEventListener('input', () => {
    bankingDeg = Number(bankingRange.value);
    document.getElementById('bankingVal')!.textContent = `${bankingDeg}°`;
    updateAffectedEdges(['A', 'B', 'C', 'D', 'E']);
    log(
      `Banking tilt set to ${bankingDeg} degrees through the cross section; banking that varies along the road is bankedRoad in @margoengine/road/banking.`,
      'info',
    );
  });

  document.getElementById('terrainFitCheck')!.addEventListener('change', (e) => {
    fitToTerrain = (e.target as HTMLInputElement).checked;
    log(`Terrain fit toggled: ${fitToTerrain}`, 'info');
    buildRoadNetwork();
  });

  document.getElementById('btnToggleRoadblock')!.addEventListener('click', () => {
    isRoadblockActive = !isRoadblockActive;
    log(`[Routing] Roadblock on B->E toggled: ${isRoadblockActive ? 'BLOCKED' : 'CLEAR'}`, 'info');
    computeShortestPath();
  });

  document.getElementById('btnRecomputePath')!.addEventListener('click', () => {
    computeShortestPath();
  });

  const carSpeedRange = document.getElementById('carSpeedRange') as HTMLInputElement;
  carSpeedRange.addEventListener('input', () => {
    carSpeed = Number(carSpeedRange.value);
    document.getElementById('carSpeedVal')!.textContent = `${carSpeed} m/s`;
  });

  const btnStress = document.getElementById('btnStressAnimate')!;
  btnStress.addEventListener('click', () => {
    isStressAnimating = !isStressAnimating;
    btnStress.textContent = isStressAnimating ? 'Stop 60 FPS Animate' : 'Start 60 FPS Animate';
    btnStress.classList.toggle('btn-active', isStressAnimating);
    log(`[Stress] 60 FPS knot animation: ${isStressAnimating}`, 'info');
  });

  document.getElementById('btnRecreateScene')!.addEventListener('click', () => {
    log('[Stress] Re-creating scene from scratch (testing disposal & memory leaks)…', 'info');
    void initScene();
  });

  const btnResizeMobile = document.getElementById('btnResizeMobile')!;
  const viewportBox = document.getElementById('viewportBox')!;
  btnResizeMobile.addEventListener('click', () => {
    viewportBox.classList.toggle('mobile-view');
    const isMobile = viewportBox.classList.contains('mobile-view');
    btnResizeMobile.textContent = isMobile ? 'Restore Viewport' : 'Toggle 390px Mobile';
    log(`[Stress] Viewport resized to ${isMobile ? '390px' : '100%'}`, 'info');
  });

  document.getElementById('btnSimulateBlur')!.addEventListener('click', () => {
    log('[Stress] Simulating window blur and focus…', 'info');
    window.dispatchEvent(new Event('blur'));
    setTimeout(() => {
      window.dispatchEvent(new Event('focus'));
      log('[Stress] Focus restored.', 'info');
    }, 500);
  });

  document.getElementById('btnClearLog')!.addEventListener('click', () => {
    logBox.innerHTML = '';
  });
}

// Start test page
setupControls();
ready(initScene());
