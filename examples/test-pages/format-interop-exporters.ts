import { ready } from './page-harness';
import { Engine, box, type Mesh, PbrMaterial, type EngineKernel } from '@margoengine/core';
import { exportGLB, exportGLTF, exportOBJ, exportPLY, exportSTL } from '@margoengine/exporters';
import { parsePLY, toGeometry } from '@margoengine/loaders';
import { parseUSDA } from '@margoengine/usdz';
import { loadFBX } from '@margoengine/fbx';
import { install as installCompat } from '@margoengine/webgl2-compat';

// UI elements
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const viewport = document.getElementById('viewport') as HTMLDivElement;
const backendBadge = document.getElementById('backend-badge') as HTMLSpanElement;

const btnLoadPly = document.getElementById('btn-load-ply') as HTMLButtonElement;
const btnLoadUsdz = document.getElementById('btn-load-usdz') as HTMLButtonElement;
const btnLoadFbx = document.getElementById('btn-load-fbx') as HTMLButtonElement;
const statFormat = document.getElementById('stat-format') as HTMLSpanElement;
const statGeo = document.getElementById('stat-geo') as HTMLSpanElement;

const btnExportGlb = document.getElementById('btn-export-glb') as HTMLButtonElement;
const btnExportGltf = document.getElementById('btn-export-gltf') as HTMLButtonElement;
const btnExportObj = document.getElementById('btn-export-obj') as HTMLButtonElement;
const btnExportPly = document.getElementById('btn-export-ply') as HTMLButtonElement;
const btnExportStl = document.getElementById('btn-export-stl') as HTMLButtonElement;
const btnVerifyRoundtrip = document.getElementById('btn-verify-roundtrip') as HTMLButtonElement;
const statExportResult = document.getElementById('stat-export-result') as HTMLSpanElement;
const statExportBytes = document.getElementById('stat-export-bytes') as HTMLSpanElement;

const btnToggleRotate = document.getElementById('btn-toggle-rotate') as HTMLButtonElement;
const btnResetCam = document.getElementById('btn-reset-cam') as HTMLButtonElement;
const btnStressExports = document.getElementById('btn-stress-exports') as HTMLButtonElement;
const btnStressSwitch = document.getElementById('btn-stress-switch') as HTMLButtonElement;
const btnResMobile = document.getElementById('btn-res-mobile') as HTMLButtonElement;
const btnResReset = document.getElementById('btn-res-reset') as HTMLButtonElement;
const btnRecreate = document.getElementById('btn-recreate') as HTMLButtonElement;
const errorToast = document.getElementById('error-toast') as HTMLDivElement;

function showError(msg: string) {
  console.error('[format-interop-exporters error]', msg);
  errorToast.style.display = 'block';
  errorToast.textContent = msg;
  setTimeout(() => {
    errorToast.style.display = 'none';
  }, 7000);
}

// App State
let engine: EngineKernel | null = null;
let activeMeshes: Mesh[] = [];
let activeModel: any = null;
let animationFrameId: number | null = null;
let rotationEnabled = true;

// Check URL backend
const urlParams = new URLSearchParams(window.location.search);
const isWebGL2 = urlParams.get('backend') === 'webgl2';

async function initScene() {
  try {
    if (isWebGL2) {
      backendBadge.textContent = 'WebGL2 Compat (Forced)';
      backendBadge.className = 'badge compat';
      console.log('[format-interop-exporters] Installing WebGL2 compatibility layer with { force: true }...');
      const res = await installCompat({ force: true });
      console.log('[format-interop-exporters] installCompat result:', res);
    } else {
      backendBadge.textContent = 'WebGPU Native';
      backendBadge.className = 'badge gpu';
    }

    // 1. Create Engine
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: {
        position: [0, 4, 10],
        target: [0, 0, 0],
        fov: 50,
      },
    });

    console.log('[format-interop-exporters] Engine created. Backend:', engine.backend);

    // 2. Build Default Procedural Scene (Hero object + Pedestal)
    buildProceduralHero();

    // 3. Start Render Loop
    engine.start();
    requestAnimationFrame(renderLoop);
  } catch (err: any) {
    showError(`Scene init failure: ${err.message}`);
  }
}

function clearActiveEntities() {
  if (activeModel) {
    try {
      if (typeof activeModel.destroy === 'function') activeModel.destroy();
      else if (typeof activeModel.dispose === 'function') activeModel.dispose();
    } catch (e) {
      console.warn('activeModel destroy warning:', e);
    }
    activeModel = null;
  }

  for (const m of activeMeshes) {
    try {
      m.dispose();
    } catch (_) {}
  }
  activeMeshes = [];
}

function buildProceduralHero() {
  if (!engine) return;
  clearActiveEntities();

  const pedestalMat = new PbrMaterial({
    color: '#334155',
    roughness: 0.7,
    metalness: 0.3,
  });
  const pedestal = engine
    .createMesh()
    .setGeometry(box(6, 0.4, 6))
    .setMaterial(pedestalMat);
  pedestal.setPosition([0, -1.2, 0]);
  pedestal.name = 'Pedestal';
  activeMeshes.push(pedestal);

  const heroMat = new PbrMaterial({
    color: '#38bdf8',
    roughness: 0.25,
    metalness: 0.85,
  });
  const heroCube = engine
    .createMesh()
    .setGeometry(box(2, 2, 2))
    .setMaterial(heroMat);
  heroCube.setPosition([0, 0.5, 0]);
  heroCube.name = 'Hero_Cube';
  activeMeshes.push(heroCube);

  statFormat.textContent = 'Procedural Assembly';
  statGeo.textContent = 'Meshes: 2 | Triangles: 24';
}

async function loadPlyModel() {
  if (!engine) return;
  clearActiveEntities();
  btnLoadPly.disabled = true;

  try {
    console.log('[format-interop-exporters] Fetching PLY torus_colored.ply...');
    const res = await fetch('/packages/loaders/tests/fixtures/torus_colored.ply');
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching PLY fixture`);
    const buffer = await res.arrayBuffer();

    const loaded = parsePLY(buffer);
    console.log('[format-interop-exporters] parsePLY loaded:', loaded);

    const geo = toGeometry(loaded, { normals: 'smooth' });
    const mat = new PbrMaterial({
      color: '#fbbf24',
      roughness: 0.35,
      metalness: 0.65,
    });
    const mesh = engine.createMesh().setGeometry(geo).setMaterial(mat);
    mesh.setPosition([0, 0, 0]);
    mesh.name = 'PLY_Torus';
    activeMeshes.push(mesh);

    const triCount = loaded.indices ? loaded.indices.length / 3 : loaded.positions.length / 9;
    statFormat.textContent = 'Stanford PLY Model';
    statGeo.textContent = `Verts: ${loaded.positions.length / 3} | Triangles: ${Math.round(triCount)}`;
    console.log('[format-interop-exporters] PLY model attached to scene.');
  } catch (err: any) {
    showError(`Load PLY failed: ${err.message}`);
  } finally {
    btnLoadPly.disabled = false;
  }
}

async function loadUsdzModel() {
  if (!engine) return;
  clearActiveEntities();
  btnLoadUsdz.disabled = true;

  try {
    console.log('[format-interop-exporters] Loading static USDZ / USDA asset...');
    const res = await fetch('/packages/usdz/tests/fixtures/triangle.usda');
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching triangle.usda`);
    const usdaText = await res.text();
    const asset = parseUSDA(usdaText);
    activeModel = await asset.create(engine);
    statFormat.textContent = 'Universal Scene Description (USDA)';
    statGeo.textContent = `USDA Primitives Ingested: ${asset.meshes.length} mesh(es)`;
    console.log('[format-interop-exporters] USDA asset attached to scene.');
  } catch (err: any) {
    showError(`Load USDZ failed: ${err.message}`);
  } finally {
    btnLoadUsdz.disabled = false;
  }
}

async function loadFbxModel() {
  if (!engine) return;
  clearActiveEntities();
  btnLoadFbx.disabled = true;

  try {
    console.log('[format-interop-exporters] Loading FBX model blender-layers.fbx...');
    const url = '/packages/fbx/test/fixtures/blender-layers.fbx';
    activeModel = await loadFBX(engine, url);
    statFormat.textContent = 'Autodesk FBX Model';
    statGeo.textContent = 'FBX Primitives Attached';
    console.log('[format-interop-exporters] FBX model loaded successfully.');
  } catch (err: any) {
    showError(`Load FBX failed: ${err.message}`);
  } finally {
    btnLoadFbx.disabled = false;
  }
}

function renderLoop(time: number) {
  if (!engine) return;

  if (rotationEnabled) {
    for (const m of activeMeshes) {
      if (m.name === 'Hero_Cube' || m.name === 'PLY_Torus') {
        try {
          m.rotation.y += 0.012;
          m.rotation.x += 0.006;
        } catch (_) {}
      }
    }
  }

  animationFrameId = requestAnimationFrame(renderLoop);
}

// Exporters Implementations
btnExportGlb.addEventListener('click', () => {
  if (!engine) return;
  try {
    const glb = exportGLB(engine);
    statExportResult.textContent = 'exportGLB: Success';
    statExportResult.style.color = '#34d399';
    statExportBytes.textContent = `${glb.byteLength.toLocaleString()} bytes`;
    console.log(`[exportGLB] Exported ${glb.byteLength} bytes.`);
  } catch (err: any) {
    showError(`exportGLB error: ${err.message}`);
  }
});

btnExportGltf.addEventListener('click', () => {
  if (!engine) return;
  try {
    const { text } = exportGLTF(engine);
    statExportResult.textContent = 'exportGLTF: Success';
    statExportResult.style.color = '#34d399';
    statExportBytes.textContent = `${text.length.toLocaleString()} chars`;
    console.log(`[exportGLTF] Exported ${text.length} characters of JSON.`);
  } catch (err: any) {
    showError(`exportGLTF error: ${err.message}`);
  }
});

btnExportObj.addEventListener('click', () => {
  if (!engine) return;
  try {
    const { obj, mtl } = exportOBJ(engine, { materials: true });
    const totalChars = obj.length + (mtl ? mtl.length : 0);
    statExportResult.textContent = 'exportOBJ: Success (OBJ+MTL)';
    statExportResult.style.color = '#34d399';
    statExportBytes.textContent = `${totalChars.toLocaleString()} chars`;
    console.log(`[exportOBJ] Exported OBJ (${obj.length} chars) + MTL (${mtl?.length ?? 0} chars).`);
  } catch (err: any) {
    showError(`exportOBJ error: ${err.message}`);
  }
});

btnExportPly.addEventListener('click', () => {
  if (!engine) return;
  try {
    const ply = exportPLY(engine, { binary: true, colors: true });
    statExportResult.textContent = 'exportPLY: Success';
    statExportResult.style.color = '#34d399';
    statExportBytes.textContent = `${ply.byteLength.toLocaleString()} bytes`;
    console.log(`[exportPLY] Exported ${ply.byteLength} bytes.`);
  } catch (err: any) {
    showError(`exportPLY error: ${err.message}`);
  }
});

btnExportStl.addEventListener('click', () => {
  if (!engine) return;
  try {
    const stl = exportSTL(engine, { binary: true });
    statExportResult.textContent = 'exportSTL: Success';
    statExportResult.style.color = '#34d399';
    statExportBytes.textContent = `${stl.byteLength.toLocaleString()} bytes`;
    console.log(`[exportSTL] Exported ${stl.byteLength} bytes.`);
  } catch (err: any) {
    showError(`exportSTL error: ${err.message}`);
  }
});

// Roundtrip Verification Test
btnVerifyRoundtrip.addEventListener('click', () => {
  if (!engine) return;
  try {
    // 1. Export scene to binary PLY
    const plyBytes = exportPLY(engine, { binary: true });
    if (!plyBytes || plyBytes.byteLength === 0) throw new Error('exportPLY produced empty output');

    // 2. Parse exported PLY with parsePLY loader
    const loaded = parsePLY(plyBytes);
    if (!loaded.positions || loaded.positions.length === 0) {
      throw new Error('parsePLY failed to reconstruct positions from exportPLY');
    }

    // 3. Export scene to binary GLB
    const glbBytes = exportGLB(engine);
    if (!glbBytes || glbBytes.byteLength < 20) throw new Error('exportGLB output too short');
    const magic = new DataView(glbBytes.buffer, glbBytes.byteOffset, 4).getUint32(0, true);
    if (magic !== 0x46546c67) {
      // 0x46546C67 is 'glTF'
      throw new Error(`Invalid GLB header magic: 0x${magic.toString(16)}`);
    }

    statExportResult.textContent = 'Roundtrip: VERIFIED (PLY + GLB)';
    statExportResult.style.color = '#38bdf8';
    statExportBytes.textContent = `PLY ${plyBytes.byteLength} B | GLB ${glbBytes.byteLength} B`;
    console.log('[Roundtrip Verification] Successfully exported and re-verified binary PLY and GLB.');
  } catch (err: any) {
    showError(`Roundtrip failed: ${err.message}`);
  }
});

// UI Event Listeners
btnLoadPly.addEventListener('click', loadPlyModel);
btnLoadUsdz.addEventListener('click', loadUsdzModel);
btnLoadFbx.addEventListener('click', loadFbxModel);

btnToggleRotate.addEventListener('click', () => {
  rotationEnabled = !rotationEnabled;
  btnToggleRotate.textContent = rotationEnabled ? 'Pause Rotation' : 'Resume Rotation';
});

btnResetCam.addEventListener('click', () => {
  if (engine?.camera) {
    engine.camera.position = [0, 4, 10];
    engine.camera.target = [0, 0, 0];
  }
});

btnStressExports.addEventListener('click', () => {
  if (!engine) return;
  console.log('[format-interop-exporters] Stress testing 25 rapid exports...');
  const start = performance.now();
  let totalBytes = 0;
  for (let i = 0; i < 5; i++) {
    totalBytes += exportGLB(engine).byteLength;
    totalBytes += exportPLY(engine, { binary: true }).byteLength;
    totalBytes += exportSTL(engine, { binary: true }).byteLength;
    totalBytes += exportOBJ(engine).obj.length;
    totalBytes += exportGLTF(engine).text.length;
  }
  const dur = (performance.now() - start).toFixed(1);
  statExportResult.textContent = `Stress: 25 exports in ${dur} ms`;
  statExportResult.style.color = '#fbbf24';
  statExportBytes.textContent = `${totalBytes.toLocaleString()} total units`;
  console.log(`[format-interop-exporters] Completed 25 exports in ${dur} ms.`);
});

btnStressSwitch.addEventListener('click', async () => {
  console.log('[format-interop-exporters] Starting rapid format switch stress...');
  await loadPlyModel();
  await new Promise((r) => setTimeout(r, 400));
  await loadUsdzModel();
  await new Promise((r) => setTimeout(r, 400));
  await loadFbxModel();
  await new Promise((r) => setTimeout(r, 400));
  buildProceduralHero();
  console.log('[format-interop-exporters] Rapid format switch finished.');
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

  clearActiveEntities();

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
  console.log('[format-interop-exporters] Recreating scene...');
  await disposeAll();
  await new Promise((r) => setTimeout(r, 200));
  await initScene();
  btnRecreate.disabled = false;
  console.log('[format-interop-exporters] Scene recreated successfully.');
});

// Launch on start
ready(initScene()).catch((err) => {
  showError(`Startup failure: ${err.message}`);
});
