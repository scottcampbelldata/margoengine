// Tile and voxel editor test page: stress and edge-case testing for:
// @margoengine/voxel, @margoengine/voxel-edit, @margoengine/tilemap,
// @margoengine/wfc, @margoengine/selection, @margoengine/inspector, @margoengine/save,
// using only documented public APIs.
import { ready } from './page-harness';
import { createStage, type Stage, Geometry, type Mesh } from '@margoengine/stage';
import { type VoxelGrid } from '@margoengine/voxel-edit';
import { meshGrid } from '@margoengine/voxel-edit/mesh';
import { VoxelHistory } from '@margoengine/voxel-edit/history';
import { sphereCells, stampCells, connectedCells } from '@margoengine/voxel-edit/edit';
import { createTileLayer, tileAt, validateTileMap, type TileMapData } from '@margoengine/tilemap';
import { WFC } from '@margoengine/wfc';
import { OverlappingModel } from '@margoengine/wfc/overlapping';
import { WFCWorkerSolve } from '@margoengine/wfc/worker';
import { Selection } from '@margoengine/selection';
import { Inspector } from '@margoengine/inspector';
import { saveGame, loadGame, memoryStorage, type SaveDocument } from '@margoengine/save';
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
const hudQuads = document.getElementById('hudQuads')!;
const hudVoxels = document.getElementById('hudVoxels')!;
const hudHistoryDepth = document.getElementById('hudHistoryDepth')!;
const wfcProgress = document.getElementById('wfcProgress')!;

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

// Palette Definitions
interface PaletteColor {
  index: number;
  name: string;
  hex: string;
}

const PALETTE: PaletteColor[] = [
  { index: 1, name: 'Grass', hex: '#4caf50' },
  { index: 2, name: 'Dirt', hex: '#795548' },
  { index: 3, name: 'Stone', hex: '#9e9e9e' },
  { index: 4, name: 'Wood', hex: '#8d6e63' },
  { index: 5, name: 'Leaves', hex: '#2e7d32' },
  { index: 6, name: 'Water', hex: '#2196f3' },
  { index: 7, name: 'Gold', hex: '#ffc107' },
  { index: 8, name: 'Brick', hex: '#e53935' },
  { index: 9, name: 'Obsidian', hex: '#212121' },
  { index: 10, name: 'White', hex: '#f5f5f5' },
];

let selectedColorIndex = 1;
type EditorTool = 'add' | 'erase' | 'paint' | 'sphere' | 'fill';
let _currentTool: EditorTool = 'add';

// Voxel Grid State
const GRID_SIZE: [number, number, number] = [16, 16, 16];
let currentGrid: VoxelGrid;
let history: VoxelHistory;

// Engine State
let stage: Stage | null = null;
let voxelMesh: Mesh | null = null;
let selectionPlugin: Selection | null = null;
let inspectorPlugin: Inspector | null = null;
const storage = memoryStorage();
let isTurntableActive = false;

// Helpers: Voxel Grid manipulation
function createEmptyGrid(size: [number, number, number]): VoxelGrid {
  return {
    size,
    voxels: new Uint8Array(size[0] * size[1] * size[2]),
  };
}

function cloneGrid(grid: VoxelGrid): VoxelGrid {
  return {
    size: [...grid.size] as [number, number, number],
    voxels: new Uint8Array(grid.voxels),
  };
}

function cellIndex(grid: VoxelGrid, x: number, y: number, z: number): number {
  return x + grid.size[0] * (z + grid.size[2] * y);
}

// Initialize starter model: small step pyramid with house block
function buildInitialModel(): VoxelGrid {
  const grid = createEmptyGrid(GRID_SIZE);
  const [sx, _sy, sz] = grid.size;

  // Layer 0: Grass base
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      grid.voxels[cellIndex(grid, x, 0, z)] = 1; // Grass
    }
  }

  // Layer 1..2: Stone courtyard
  for (let z = 2; z < sz - 2; z++) {
    for (let x = 2; x < sx - 2; x++) {
      grid.voxels[cellIndex(grid, x, 1, z)] = 3; // Stone
      if (x >= 4 && x < sx - 4 && z >= 4 && z < sz - 4) {
        grid.voxels[cellIndex(grid, x, 2, z)] = 8; // Brick
      }
    }
  }

  // Tower in center
  for (let y = 3; y < 8; y++) {
    for (let z = 6; z < 10; z++) {
      for (let x = 6; x < 10; x++) {
        grid.voxels[cellIndex(grid, x, y, z)] = y === 7 ? 7 : 4; // Wood with Gold top
      }
    }
  }

  return grid;
}

// Remesh and update Voxel Mesh in Stage
function updateVoxelMesh() {
  if (!stage) return;

  const t0 = performance.now();
  const { mesh, stats } = meshGrid(currentGrid, {
    ambientOcclusion: true,
    pivot: [GRID_SIZE[0] / 2, 0, GRID_SIZE[2] / 2],
  });

  hudQuads.textContent = stats.quads.toLocaleString('en');
  hudVoxels.textContent = stats.voxels.toLocaleString('en');
  hudHistoryDepth.textContent = String(history.depth);

  // Check if grid has triangles
  if (mesh.indices.length === 0) {
    // Empty grid edge-case: core Geometry throws on empty indices!
    log('[warning] Grid is completely empty (0 quads). Core Geometry throws on empty indices.', 'warn');
    if (voxelMesh) {
      try {
        voxelMesh.dispose?.();
      } catch {}
      voxelMesh = null;
    }
    drawTilemapPreview();
    return;
  }

  const geom = new Geometry(mesh.positions, mesh.normals, mesh.indices);

  if (!voxelMesh) {
    voxelMesh = stage.mesh(geom, {
      color: '#ffffff',
      roughness: 0.8,
      metalness: 0.1,
      name: 'VoxelModel',
    });
    if (selectionPlugin) {
      selectionPlugin.set([voxelMesh]);
    }
  } else {
    voxelMesh.setGeometry(geom);
  }

  const ms = performance.now() - t0;
  log(`[Mesh] Voxel grid remeshed: ${stats.quads} quads, ${stats.voxels} voxels in ${ms.toFixed(1)} ms.`, 'info');

  drawTilemapPreview();
}

// Draw 2D Tilemap representation of bottom slice (y = 0)
function drawTilemapPreview() {
  const canvas = document.getElementById('tilemapCanvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = GRID_SIZE[0] * 12;
  canvas.height = GRID_SIZE[2] * 12;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Validate tilemap data with @margoengine/tilemap
  try {
    const tileData = new Uint32Array(GRID_SIZE[0] * GRID_SIZE[2]);
    for (let z = 0; z < GRID_SIZE[2]; z++) {
      for (let x = 0; x < GRID_SIZE[0]; x++) {
        const val = currentGrid.voxels[cellIndex(currentGrid, x, 0, z)];
        tileData[z * GRID_SIZE[0] + x] = val;
      }
    }

    const layer = createTileLayer('ground', GRID_SIZE[0], GRID_SIZE[2], tileData);
    const mapData: TileMapData = {
      width: GRID_SIZE[0],
      height: GRID_SIZE[2],
      tileWidth: 16,
      tileHeight: 16,
      layers: [layer],
      tilesets: [
        {
          name: 'voxel-palette',
          firstGid: 1,
          tileWidth: 16,
          tileHeight: 16,
          tileCount: 16,
          columns: 4,
        },
      ],
    };
    validateTileMap(mapData);

    // Draw grid pixels
    for (let z = 0; z < GRID_SIZE[2]; z++) {
      for (let x = 0; x < GRID_SIZE[0]; x++) {
        const gid = tileAt(layer, x, z);
        const col = PALETTE.find((p) => p.index === gid)?.hex ?? '#161b22';
        ctx.fillStyle = col;
        ctx.fillRect(x * 12, z * 12, 11, 11);
      }
    }
  } catch (err) {
    log(`[TileMap] Tilemap validation error: ${(err as Error).message}`, 'error');
  }
}

// Initialize Stage
async function initScene() {
  if (stage) {
    try {
      if (inspectorPlugin) {
        inspectorPlugin.dispose();
        inspectorPlugin = null;
      }
      stage.dispose();
      log('[Lifecycle] Previous stage disposed cleanly.', 'info');
    } catch (e) {
      log(`[Lifecycle] stage.dispose() error: ${(e as Error).message}`, 'error');
    }
    stage = null;
    voxelMesh = null;
    selectionPlugin = null;
  }

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  log(`[Init] Creating Stage (backend: ${isWebgl2 ? 'webgl2' : 'auto'})…`, 'info');

  try {
    if (isWebgl2) {
      await installWebGL2Compat({ force: true });
    }
    stage = await createStage(canvas, {
      camera: { position: [18, 22, 28], target: [0, 4, 0], near: 0.1, far: 500 },
      onError: (err) => log(`Stage engine error: ${String(err)}`, 'error'),
    });
    log('[Init] Stage initialized successfully.', 'info');
  } catch (err) {
    log(`Failed to create stage: ${(err as Error).message}`, 'error');
    return;
  }

  // 1. Attach Selection Plugin
  try {
    selectionPlugin = Selection.attach(stage.engine, {
      algorithm: 'jfa',
      width: 2.5,
      color: [1.0, 0.6, 0.1],
    });
    log('[Selection] Selection outline attached.', 'info');
  } catch (err) {
    log(`[Selection] Selection.attach error: ${(err as Error).message}`, 'error');
  }

  // 2. Attach DOM Inspector Plugin
  try {
    const inspectorContainer = document.getElementById('inspectorContainer')!;
    inspectorContainer.innerHTML = '';
    inspectorPlugin = Inspector.attach(stage.engine, {
      parent: inspectorContainer,
      pick: true,
      historyLimit: 120,
    });
    Object.assign(inspectorPlugin.element.style, {
      position: 'relative',
      top: 'auto',
      right: 'auto',
      width: '100%',
      maxHeight: '180px',
      overflow: 'auto',
    });
    log('[Inspector] DOM Inspector attached.', 'info');
  } catch (err) {
    log(`[Inspector] Inspector.attach error: ${(err as Error).message}`, 'error');
  }

  // 3. Initialize Model & History
  currentGrid = buildInitialModel();
  history = new VoxelHistory(currentGrid, { maxDepth: 128 });

  // 4. Mesh initial grid
  updateVoxelMesh();

  // 5. Setup frame tick
  stage.onTick((delta) => {
    onFrameTick(delta);
  });
}

// Frame Tick & Telemetry
let lastFrameTime = performance.now();
let frameCount = 0;
let lastFpsUpdate = performance.now();
let turntableAngle = 0;

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
  }

  // Turntable rotation
  if (isTurntableActive && voxelMesh) {
    turntableAngle += delta * 0.8;
    voxelMesh.rotation.set(0, turntableAngle, 0);
  }
}

// Painting & Editing Operations
function applyVoxelEdit(editFn: (grid: VoxelGrid) => VoxelGrid | void, label: string) {
  const nextGrid = cloneGrid(currentGrid);
  const result = editFn(nextGrid);
  currentGrid = result ?? nextGrid;
  history.push(currentGrid, label);
  updateVoxelMesh();
}

function addRandomVoxel() {
  applyVoxelEdit((grid) => {
    const x = Math.floor(Math.random() * GRID_SIZE[0]);
    const y = Math.floor(Math.random() * (GRID_SIZE[1] - 4)) + 1;
    const z = Math.floor(Math.random() * GRID_SIZE[2]);
    grid.voxels[cellIndex(grid, x, y, z)] = selectedColorIndex;
  }, 'Add Voxel');
}

function eraseRandomVoxel() {
  applyVoxelEdit((grid) => {
    // Find a filled voxel above y > 0
    for (let i = grid.voxels.length - 1; i >= GRID_SIZE[0] * GRID_SIZE[2]; i--) {
      if (grid.voxels[i] !== 0) {
        grid.voxels[i] = 0;
        break;
      }
    }
  }, 'Erase Voxel');
}

function applySphereBrush() {
  applyVoxelEdit((grid) => {
    const cx = 8,
      cy = 8,
      cz = 8,
      radius = 3;
    const cells = sphereCells([cx, cy, cz], radius);
    const indices: number[] = [];
    for (const [x, y, z] of cells) {
      if (x >= 0 && x < grid.size[0] && y >= 0 && y < grid.size[1] && z >= 0 && z < grid.size[2]) {
        indices.push(cellIndex(grid, x, y, z));
      }
    }
    const edit = stampCells(grid, indices, { operation: 'fill', color: selectedColorIndex });
    return edit.grid;
  }, 'Sphere Brush');
}

function applyFloodFill() {
  applyVoxelEdit((grid) => {
    // Connect fill on layer 1 from seed [4, 1, 4]
    const cells = connectedCells(grid, [4, 1, 4]);
    const edit = stampCells(grid, cells, { operation: 'fill', color: selectedColorIndex });
    return edit.grid;
  }, 'Flood Fill');
}

// Stress Test: 50x Rapid Paint, Undo, and Redo
async function stressHistory() {
  log('[Stress] Starting 50x Paint / Undo / Redo stress loop…', 'info');
  const t0 = performance.now();

  for (let i = 0; i < 20; i++) {
    addRandomVoxel();
  }

  for (let i = 0; i < 15; i++) {
    if (history.canUndo) {
      currentGrid = history.undo();
      updateVoxelMesh();
    }
  }

  for (let i = 0; i < 10; i++) {
    if (history.canRedo) {
      currentGrid = history.redo();
      updateVoxelMesh();
    }
  }

  const ms = performance.now() - t0;
  log(`[Stress] 50x Paint/Undo/Redo completed in ${ms.toFixed(1)} ms. History depth: ${history.depth}`, 'info');
}

// Wave Function Collapse (WFC) Solve & Cancellation Tests
async function runWfcSolveFull() {
  wfcProgress.textContent = 'Solving WFC (Full)…';
  log('[WFC] Running full 3D WFC solve on [8, 8, 8] grid…', 'info');
  const t0 = performance.now();

  try {
    // Define reciprocal adjacency tiles
    // Tile 0: Air, Tile 1: Stone, Tile 2: Wood
    const tiles = [
      {
        weight: 3,
        neighbors: [
          [0, 1],
          [0, 1],
          [0, 1],
          [0, 1],
          [0, 1],
          [0, 1],
        ],
      },
      {
        weight: 2,
        neighbors: [
          [0, 1, 2],
          [0, 1, 2],
          [0, 1, 2],
          [0, 1, 2],
          [0, 1, 2],
          [0, 1, 2],
        ],
      },
      {
        weight: 1,
        neighbors: [
          [1, 2],
          [1, 2],
          [1, 2],
          [1, 2],
          [1, 2],
          [1, 2],
        ],
      },
    ];

    const wfc = new WFC([8, 8, 8], tiles);
    const result = wfc.solve(42, [], 32);

    // Apply result to top half of voxel grid
    applyVoxelEdit((grid) => {
      for (let z = 0; z < 8; z++) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const t = result[x + 8 * (y + 8 * z)];
            grid.voxels[cellIndex(grid, x + 4, y + 4, z + 4)] = t === 0 ? 0 : t === 1 ? 3 : 4;
          }
        }
      }
    }, 'WFC Full Solve');

    const ms = performance.now() - t0;
    wfcProgress.textContent = `WFC Solved in ${ms.toFixed(1)} ms`;
    log(`[WFC] Full WFC solve completed in ${ms.toFixed(1)} ms.`, 'info');
  } catch (err) {
    wfcProgress.textContent = 'WFC Error';
    log(`[WFC] WFC solve error: ${(err as Error).message}`, 'error');
  }
}

// WFC Cancel Halfway Test
async function runWfcCancelHalfway() {
  wfcProgress.textContent = 'Starting WFC (Cancelling Halfway)…';
  log('[WFC] Testing WFC cancellation halfway via AbortController…', 'info');

  const controller = new AbortController();

  // Test 1: Test OverlappingModel solve with aborted signal
  try {
    const rows = ['1111', '1001', '1001', '1111'];
    const sample = { data: rows.join('').split('').map(Number), width: 4, height: 4 };
    const model = new OverlappingModel(sample, { N: 2 });

    // solve is synchronous, so a timer cannot fire during it (packages/wfc/README.md); a signal aborted before the
    // call must throw the caller's reason. The worker solve below covers cancelling a running solve.
    controller.abort('WFC solve aborted by user');
    const out = model.solve(32, 32, { seed: 99, attempts: 8, signal: controller.signal });

    log(
      `[WFC] OverlappingModel.solve ran with a pre-aborted signal; the README says it throws. Output length = ${out.length}`,
      'error',
    );
    wfcProgress.textContent = 'Cancelled (Ignored)';
  } catch (err) {
    if (err === 'WFC solve aborted by user') {
      log("[WFC] OverlappingModel threw the caller's abort reason as documented.", 'info');
      wfcProgress.textContent = 'Cancelled Successfully';
    } else {
      log(`[WFC] Unexpected error on cancellation: ${String(err)}`, 'error');
    }
  }

  // Test 2: WFCWorkerSolve cancellation
  try {
    const workerController = new AbortController();
    const tiles = [{ weight: 1, neighbors: [[0], [0], [0], [0], [0], [0]] }];
    const job = new WFCWorkerSolve([16, 16, 1], tiles, {
      seed: 7,
      signal: workerController.signal,
    });

    // Abort immediately
    workerController.abort('Worker job cancelled');
    job.dispose();

    try {
      await job.result;
      log('[WFC][warning] BUG/FLAW: WFCWorkerSolve did not reject after disposal/abort!', 'warn');
    } catch (workerErr) {
      log(`[WFC] WFCWorkerSolve rejected on abort as expected: ${String(workerErr)}`, 'info');
    }
  } catch (err) {
    log(`[WFC] WFCWorkerSolve test error: ${(err as Error).message}`, 'error');
  }
}

// Save & Reload Tests (@margoengine/save)
async function saveSceneDocument() {
  log('[Save] Saving current scene to storage…', 'info');
  const t0 = performance.now();

  try {
    const doc: SaveDocument = {
      format: 'margo-save',
      version: 1,
      meta: { title: 'Voxel Level', timestamp: Date.now() },
      entities: [
        {
          id: 'voxel-model-root',
          name: 'VoxelModel',
          transform: { position: [0, 0, 0] },
          components: {
            gridData: {
              size: [currentGrid.size[0], currentGrid.size[1], currentGrid.size[2]],
              voxels: Array.from(currentGrid.voxels),
            },
            historyDepth: history.depth,
          },
        },
      ],
    };

    await saveGame(storage, 'voxel-level-save', doc);
    const ms = performance.now() - t0;
    log(`[Save] Document saved to slot "voxel-level-save" in ${ms.toFixed(1)} ms.`, 'info');
  } catch (err) {
    log(`[Save] Save failure: ${(err as Error).message}`, 'error');
  }
}

function clearCurrentScene() {
  log('[Save] Clearing scene to empty air…', 'info');
  currentGrid = createEmptyGrid(GRID_SIZE);
  history = new VoxelHistory(currentGrid, { maxDepth: 128 });
  updateVoxelMesh();
}

async function reloadSceneDocument() {
  log('[Save] Reloading document from storage…', 'info');
  const t0 = performance.now();

  try {
    const loaded = await loadGame(storage, 'voxel-level-save');
    if (!loaded) {
      log('[Save] No save file found in storage slot!', 'warn');
      return;
    }

    const entity = loaded.entities?.find((e) => e.id === 'voxel-model-root');
    const gridData = entity?.components?.gridData as { size: [number, number, number]; voxels: number[] };

    if (!gridData || !gridData.voxels) {
      log('[Save] Corrupted or missing gridData component in save!', 'error');
      return;
    }

    currentGrid = {
      size: gridData.size,
      voxels: new Uint8Array(gridData.voxels),
    };
    history = new VoxelHistory(currentGrid, { maxDepth: 128 });
    updateVoxelMesh();

    const ms = performance.now() - t0;
    log(`[Save] Document reloaded successfully in ${ms.toFixed(1)} ms.`, 'info');
  } catch (err) {
    log(`[Save] Reload error: ${(err as Error).message}`, 'error');
  }
}

// Setup Palette UI
function setupPaletteUI() {
  const container = document.getElementById('paletteGrid')!;
  container.innerHTML = '';

  for (const item of PALETTE) {
    const swatch = document.createElement('div');
    swatch.className = `swatch ${item.index === selectedColorIndex ? 'selected' : ''}`;
    swatch.style.background = item.hex;
    swatch.title = `${item.name} (${item.index})`;
    swatch.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
      swatch.classList.add('selected');
      selectedColorIndex = item.index;
      log(`[Palette] Selected ${item.name} (index ${item.index})`, 'info');
    });
    container.appendChild(swatch);
  }
}

// Setup Event Listeners
function setupControls() {
  setupPaletteUI();

  // Tool buttons
  const lblCurrentTool = document.getElementById('lblCurrentTool')!;
  const toolButtons: Record<EditorTool, HTMLElement> = {
    add: document.getElementById('btnToolAdd')!,
    erase: document.getElementById('btnToolErase')!,
    paint: document.getElementById('btnToolPaint')!,
    sphere: document.getElementById('btnToolSphere')!,
    fill: document.getElementById('btnToolFill')!,
  };

  const selectTool = (tool: EditorTool, label: string) => {
    _currentTool = tool;
    lblCurrentTool.textContent = label;
    Object.values(toolButtons).forEach((btn) => btn.classList.remove('active'));
    toolButtons[tool].classList.add('active');
  };

  toolButtons.add.addEventListener('click', () => {
    selectTool('add', 'Add Block');
    addRandomVoxel();
  });
  toolButtons.erase.addEventListener('click', () => {
    selectTool('erase', 'Erase Block');
    eraseRandomVoxel();
  });
  toolButtons.paint.addEventListener('click', () => {
    selectTool('paint', 'Paint Color');
    addRandomVoxel();
  });
  toolButtons.sphere.addEventListener('click', () => {
    selectTool('sphere', 'Sphere Brush');
    applySphereBrush();
  });
  toolButtons.fill.addEventListener('click', () => {
    selectTool('fill', 'Flood Fill');
    applyFloodFill();
  });

  // Undo / Redo
  document.getElementById('btnUndo')!.addEventListener('click', () => {
    if (history.canUndo) {
      currentGrid = history.undo();
      updateVoxelMesh();
      log('[History] Undo step executed.', 'info');
    } else {
      log('[History] Nothing to undo.', 'warn');
    }
  });

  document.getElementById('btnRedo')!.addEventListener('click', () => {
    if (history.canRedo) {
      currentGrid = history.redo();
      updateVoxelMesh();
      log('[History] Redo step executed.', 'info');
    } else {
      log('[History] Nothing to redo.', 'warn');
    }
  });

  document.getElementById('btnStressHistory')!.addEventListener('click', () => {
    stressHistory();
  });

  // WFC Buttons
  document.getElementById('btnWfcSolveFull')!.addEventListener('click', () => {
    runWfcSolveFull();
  });

  document.getElementById('btnWfcCancelHalfway')!.addEventListener('click', () => {
    runWfcCancelHalfway();
  });

  // Save / Clear / Reload
  document.getElementById('btnSaveScene')!.addEventListener('click', () => {
    saveSceneDocument();
  });

  document.getElementById('btnClearScene')!.addEventListener('click', () => {
    clearCurrentScene();
  });

  document.getElementById('btnReloadScene')!.addEventListener('click', () => {
    reloadSceneDocument();
  });

  // Turntable Toggle
  const btnToggleTurntable = document.getElementById('btnToggleTurntable')!;
  btnToggleTurntable.addEventListener('click', () => {
    isTurntableActive = !isTurntableActive;
    btnToggleTurntable.classList.toggle('active', isTurntableActive);
    log(`[Turntable] 60 FPS turntable rotation: ${isTurntableActive}`, 'info');
  });

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

  // Focus Loss / Restore Simulation
  document.getElementById('btnSimulateFocusLoss')!.addEventListener('click', () => {
    log('[Stress] Simulating window blur / focus loss…', 'info');
    window.dispatchEvent(new Event('blur'));
    setTimeout(() => {
      log('[Stress] Simulating window focus restore…', 'info');
      window.dispatchEvent(new Event('focus'));
    }, 800);
  });

  // Disposal & Re-creation
  document.getElementById('btnRecreateScene')!.addEventListener('click', () => {
    log('[Stress] Re-creating scene from scratch…', 'info');
    initScene();
  });
}

// Start
setupControls();
ready(initScene());
