import { ready } from './page-harness';
import { Engine, Geometry, PbrMaterial, type Mesh } from '@margoengine/core';
import { install as installCompat } from '@margoengine/webgl2-compat';
import {
  createPrimitiveMesh,
  extrudeMeshFace,
  bevelPolygonMesh,
  insetMeshFace,
  compilePolygonMesh,
  type PolygonMesh,
} from '@margoengine/mesh-edit';
import { subdivideMesh } from '@margoengine/mesh-edit/modeling';
import { loadGLTF } from '@margoengine/gltf';
import { getWorldPosition, lookAt, traverse, userData } from '@margoengine/scene';
import { Vector3, Color } from '@margoengine/math';
import { NodeMaterial, uniform, color, sin, time } from '@margoengine/shader';
import { createMesh as createMaterialMesh, type MaterialMesh } from '@margoengine/materials';

// --- Global UI elements ---
const elStatusBackend = document.getElementById('badge-backend')!;
const elMeshStats = document.getElementById('val-mesh-stats')!;
const elHistoryLevel = document.getElementById('val-history-level')!;
const elShaderMode = document.getElementById('val-shader-mode')!;
const elSceneNodes = document.getElementById('val-scene-nodes')!;
const elFps = document.getElementById('val-fps')!;
const elLog = document.getElementById('log')!;

const btnExtrude = document.getElementById('btn-op-extrude') as HTMLButtonElement;
const btnBevel = document.getElementById('btn-op-bevel') as HTMLButtonElement;
const btnInset = document.getElementById('btn-op-inset') as HTMLButtonElement;
const btnSubdivide = document.getElementById('btn-op-subdivide') as HTMLButtonElement;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnRedo = document.getElementById('btn-redo') as HTMLButtonElement;
const btnToggleShader = document.getElementById('btn-toggle-shader') as HTMLButtonElement;
const btnTogglePulse = document.getElementById('btn-toggle-pulse') as HTMLButtonElement;
const btnSaveScene = document.getElementById('btn-save-scene') as HTMLButtonElement;
const btnReloadScene = document.getElementById('btn-reload-scene') as HTMLButtonElement;
const btnStressEdits = document.getElementById('btn-stress-edits') as HTMLButtonElement;
const btnTestMobile = document.getElementById('btn-test-mobile') as HTMLButtonElement;
const btnRecreate = document.getElementById('btn-recreate') as HTMLButtonElement;
const viewportEl = document.getElementById('viewport')!;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

function log(msg: string) {
  elLog.textContent = msg;
  console.log(`[MeshEditingStudio] ${msg}`);
}

// Check URL parameter for backend
const params = new URLSearchParams(window.location.search);
const requestedBackend = params.get('backend') || 'webgpu';
elStatusBackend.textContent = requestedBackend.toUpperCase();

let engine: Engine | null = null;
let gltfModel: any = null;
let editableMeshNode: Mesh | null = null;
let editableMaterialMesh: MaterialMesh<any> | null = null;
let nodeMat: NodeMaterial | null = null;
let fallbackMat: PbrMaterial | null = null;
let shaderActive = false; // default to PbrMaterial, toggle enables NodeMaterial
let pulseActive = false;
let shaderTintUniform: any = null;

// History stack for mesh editing
let polyMeshHistory: PolygonMesh[] = [];
let historyIndex = -1;
let savedSceneState: string | null = null;

function updateStatsHUD() {
  if (historyIndex >= 0 && historyIndex < polyMeshHistory.length) {
    const m = polyMeshHistory[historyIndex];
    elMeshStats.textContent = `${m.vertices.length} v / ${m.faces.length} f`;
    elHistoryLevel.textContent = `Step ${historyIndex + 1} / ${polyMeshHistory.length}`;
  } else {
    elMeshStats.textContent = '0 v / 0 f';
    elHistoryLevel.textContent = 'Step 0 / 0';
  }

  btnUndo.disabled = historyIndex <= 0;
  btnRedo.disabled = historyIndex >= polyMeshHistory.length - 1;

  if (engine) {
    let count = 0;
    traverse(engine.scene, () => {
      count++;
    });
    elSceneNodes.textContent = String(count);
  }
}

function applyPolygonMeshToStudio(poly: PolygonMesh) {
  if (!engine) return;
  const compiled = compilePolygonMesh(poly);
  const posArr = new Float32Array(compiled.positions);
  const normArr = new Float32Array(compiled.normals);
  const idxArr = new Uint32Array(compiled.indices);

  const isWebGPU = requestedBackend !== 'webgl2';

  if (shaderActive && nodeMat && isWebGPU) {
    // MaterialMesh route using @margoengine/materials + @margoengine/shader
    if (editableMeshNode) {
      editableMeshNode.dispose();
      editableMeshNode = null;
    }
    if (editableMaterialMesh) {
      editableMaterialMesh.destroy();
      editableMaterialMesh = null;
    }
    editableMaterialMesh = createMaterialMesh(
      engine,
      {
        positions: posArr,
        normals: normArr,
        indices: idxArr,
      },
      nodeMat,
    );
    editableMaterialMesh.root.setPosition([1.5, 0, 0]);
    userData(editableMaterialMesh.root).role = 'editable-mesh';
    userData(editableMaterialMesh.root).source = 'polygonMesh';
  } else {
    // Core Mesh route
    if (editableMaterialMesh) {
      editableMaterialMesh.destroy();
      editableMaterialMesh = null;
    }
    if (!editableMeshNode) {
      editableMeshNode = engine.createMesh().setPosition([1.5, 0, 0]);
      userData(editableMeshNode).role = 'editable-mesh';
      userData(editableMeshNode).source = 'polygonMesh';
      if (fallbackMat) editableMeshNode.setMaterial(fallbackMat);
    }
    const geom = new Geometry(posArr, normArr, idxArr);
    editableMeshNode.setGeometry(geom);
  }
  updateStatsHUD();
}

function pushMeshEdit(newPoly: PolygonMesh, desc: string) {
  polyMeshHistory = polyMeshHistory.slice(0, historyIndex + 1);
  polyMeshHistory.push(newPoly);
  historyIndex = polyMeshHistory.length - 1;
  applyPolygonMeshToStudio(newPoly);
  log(`Applied: ${desc} (${newPoly.vertices.length} vertices, ${newPoly.faces.length} faces)`);
}

function setupMaterials(isWebGPU: boolean) {
  fallbackMat = new PbrMaterial({
    color: '#38bdf8',
    roughness: 0.35,
    metalness: 0.15,
  });

  if (isWebGPU) {
    try {
      shaderTintUniform = uniform('#38bdf8', { name: 'tint' });
      nodeMat = new NodeMaterial({
        roughness: 0.35,
        metalness: 0.15,
        colorNode: color('#38bdf8'),
        emissiveNode: shaderTintUniform.mul(sin(time).mul(0.2).add(0.2)),
      });
      elShaderMode.textContent = 'NodeMaterial available (WGSL)';
    } catch (err: any) {
      log(`NodeMaterial init warning: ${err.message}`);
      nodeMat = null;
      elShaderMode.textContent = 'Fallback PbrMaterial';
    }
  } else {
    nodeMat = null;
    elShaderMode.textContent = 'WebGL2 (PbrMaterial fallback)';
  }
}

async function initStudio() {
  if (engine) {
    engine.dispose();
    engine = null;
  }
  editableMeshNode = null;
  editableMaterialMesh = null;
  gltfModel = null;

  log(`Initializing engine with backend: ${requestedBackend}...`);

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

  // Camera setup with @margoengine/math
  const camPos = new Vector3(0, 2, 7);
  engine.camera.position = camPos.toArray();
  engine.camera.target = [0, 0, 0];

  const isWebGPU = requestedBackend !== 'webgl2';
  setupMaterials(isWebGPU);

  // Initial base primitive
  const initialCube = createPrimitiveMesh('cube', 'box');
  polyMeshHistory = [initialCube];
  historyIndex = 0;
  applyPolygonMeshToStudio(initialCube);

  // Load real glTF sample model
  try {
    log('Loading glTF model /examples/assets/skinning-ik-orb.glb...');
    gltfModel = await loadGLTF(engine, '/examples/assets/skinning-ik-orb.glb');
    if (gltfModel && gltfModel.root) {
      gltfModel.root.setPosition([-2, 0, 0]);
      gltfModel.root.setScale([1.5, 1.5, 1.5]);

      // Use @margoengine/scene utilities
      traverse(gltfModel.root, (childMesh: Mesh) => {
        userData(childMesh).source = 'gltf-skinning-ik-orb';
      });

      lookAt(gltfModel.root, [0, 0, 5]);
      const worldPos = getWorldPosition(gltfModel.root);
      log(
        `glTF loaded. Nodes: ${gltfModel.nodes?.length ?? 1}, pos: [${worldPos.map((n: number) => n.toFixed(1)).join(', ')}]`,
      );
    }
  } catch (err: any) {
    log(`glTF load warning: ${err.message}`);
  }

  // Scene animation loop
  let frameCount = 0;
  let fpsTimer = 0;

  engine.onFrame((_, delta) => {
    frameCount++;
    fpsTimer += delta;
    if (fpsTimer >= 0.5) {
      const fps = Math.round(frameCount / fpsTimer);
      const ms = ((delta || 0.016) * 1000).toFixed(1);
      elFps.textContent = `${fps} fps (${ms}ms)`;
      frameCount = 0;
      fpsTimer = 0;
    }

    // Animate tint if pulse enabled
    if (pulseActive && shaderTintUniform) {
      const t = performance.now() * 0.003;
      const r = Math.sin(t) * 0.5 + 0.5;
      const g = Math.sin(t + 2) * 0.5 + 0.5;
      const b = Math.sin(t + 4) * 0.5 + 0.5;
      const hex = new Color(r, g, b).getHexString();
      shaderTintUniform.value = `#${hex}`;
    }

    // Rotate meshes for presentation
    if (editableMeshNode) {
      editableMeshNode.rotation.y += delta * 0.3;
    } else if (editableMaterialMesh && editableMaterialMesh.root) {
      editableMaterialMesh.root.rotation.y += delta * 0.3;
    }

    if (gltfModel && gltfModel.root) {
      gltfModel.root.rotation.y -= delta * 0.2;
    }
  });

  engine.start();
  updateStatsHUD();
  log(`Studio ready on ${requestedBackend}.`);
}

// --- Mesh Editing Operations ---
btnExtrude.onclick = () => {
  if (historyIndex < 0) return;
  const current = polyMeshHistory[historyIndex];
  if (current.faces.length === 0) return;
  const targetFace = current.faces[current.faces.length - 1];
  try {
    const result = extrudeMeshFace(current, targetFace.id, 0.3);
    pushMeshEdit(result.mesh, `Extrude face ${targetFace.id}`);
  } catch (err: any) {
    log(`Extrude error: ${err.message}`);
  }
};

btnBevel.onclick = () => {
  if (historyIndex < 0) return;
  const current = polyMeshHistory[historyIndex];
  try {
    const result = bevelPolygonMesh(current, 0.08);
    pushMeshEdit(result.mesh, 'Bevel mesh');
  } catch (err: any) {
    log(`Bevel error: ${err.message}`);
  }
};

btnInset.onclick = () => {
  if (historyIndex < 0) return;
  const current = polyMeshHistory[historyIndex];
  if (current.faces.length === 0) return;
  const targetFace = current.faces[0];
  try {
    const result = insetMeshFace(current, targetFace.id, 0.25);
    pushMeshEdit(result.mesh, `Inset face ${targetFace.id}`);
  } catch (err: any) {
    log(`Inset error: ${err.message}`);
  }
};

btnSubdivide.onclick = () => {
  if (historyIndex < 0) return;
  const current = polyMeshHistory[historyIndex];
  try {
    const result = subdivideMesh(current, { levels: 1 });
    pushMeshEdit(result.mesh, 'Subdivide 1-level');
  } catch (err: any) {
    log(`Subdivide error: ${err.message}`);
  }
};

btnUndo.onclick = () => {
  if (historyIndex > 0) {
    historyIndex--;
    applyPolygonMeshToStudio(polyMeshHistory[historyIndex]);
    log(`Undo: stepped back to step ${historyIndex + 1}`);
  }
};

btnRedo.onclick = () => {
  if (historyIndex < polyMeshHistory.length - 1) {
    historyIndex++;
    applyPolygonMeshToStudio(polyMeshHistory[historyIndex]);
    log(`Redo: stepped forward to step ${historyIndex + 1}`);
  }
};

// --- Custom Shader Material Toggle ---
btnToggleShader.onclick = () => {
  shaderActive = !shaderActive;
  btnToggleShader.classList.toggle('active', shaderActive);

  if (historyIndex >= 0) {
    applyPolygonMeshToStudio(polyMeshHistory[historyIndex]);
  }

  if (shaderActive) {
    if (requestedBackend === 'webgl2') {
      elShaderMode.textContent = 'PbrMaterial (WebGL2 fallback)';
      log('Shader active: WebGL2 using PbrMaterial fallback.');
    } else {
      elShaderMode.textContent = 'NodeMaterial (WGSL)';
      log('Switched to NodeMaterial');
    }
  } else {
    elShaderMode.textContent = 'PbrMaterial';
    log('Switched to standard PbrMaterial');
  }
};

btnTogglePulse.onclick = () => {
  pulseActive = !pulseActive;
  btnTogglePulse.classList.toggle('active', pulseActive);
  log(`Animated tint pulse: ${pulseActive ? 'ENABLED' : 'DISABLED'}`);
};

// --- Scene Save & Reload ---
btnSaveScene.onclick = () => {
  if (!engine) return;
  const sceneExport: any = {
    camera: {
      position: [...engine.camera.position],
      target: [...engine.camera.target],
    },
    meshes: [] as any[],
  };

  traverse(engine.scene, (mesh: Mesh) => {
    const data = userData(mesh);
    const item: any = {
      position: [mesh.position.x, mesh.position.y, mesh.position.z],
      rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
      scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
      userData: { ...data },
    };
    if (data.role === 'editable-mesh' && historyIndex >= 0) {
      item.polygonMesh = polyMeshHistory[historyIndex];
    }
    sceneExport.meshes.push(item);
  });

  savedSceneState = JSON.stringify(sceneExport, null, 2);
  log(`Scene saved to JSON (${sceneExport.meshes.length} nodes, ${savedSceneState.length} bytes).`);
};

btnReloadScene.onclick = async () => {
  if (!engine || !savedSceneState) {
    log('No saved scene state found! Click "Save Scene JSON" first.');
    return;
  }

  log('Reloading scene from saved JSON state...');
  try {
    const sceneData = JSON.parse(savedSceneState);
    if (sceneData.camera) {
      engine.camera.position = sceneData.camera.position;
      engine.camera.target = sceneData.camera.target;
    }

    for (const item of sceneData.meshes) {
      if (item.userData?.role === 'editable-mesh' && item.polygonMesh) {
        pushMeshEdit(item.polygonMesh, 'Reloaded saved mesh state');
        const target = editableMeshNode || (editableMaterialMesh && editableMaterialMesh.root);
        if (target) {
          target.setPosition(item.position);
          target.setRotation(item.rotation);
          target.setScale(item.scale);
        }
      }
    }
    updateStatsHUD();
    log('Scene successfully restored from JSON!');
  } catch (err: any) {
    log(`Reload failed: ${err.message}`);
  }
};

// --- Stress Tests ---
btnStressEdits.onclick = () => {
  log('Running 10x consecutive mesh edits (extrude, inset)...');
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) {
    btnExtrude.click();
    btnInset.click();
  }
  const elapsed = (performance.now() - t0).toFixed(1);
  log(`10x edits completed in ${elapsed}ms. Vertices: ${polyMeshHistory[historyIndex].vertices.length}`);
};

btnTestMobile.onclick = () => {
  viewportEl.classList.toggle('mobile-view');
  const isMobile = viewportEl.classList.contains('mobile-view');
  btnTestMobile.classList.toggle('active', isMobile);
  log(`Resized viewport to ${isMobile ? '390x844 (Mobile)' : 'Full Window'}`);
};

btnRecreate.onclick = async () => {
  log('Recreating engine instance...');
  await initStudio();
  log('Engine recreated successfully.');
};

// Expose test harness hooks on window
(window as any).__TEST_HARNESS__ = {
  getStats: () => ({
    backend: requestedBackend,
    historyLength: polyMeshHistory.length,
    historyIndex,
    vertices: historyIndex >= 0 ? polyMeshHistory[historyIndex].vertices.length : 0,
    faces: historyIndex >= 0 ? polyMeshHistory[historyIndex].faces.length : 0,
    gltfLoaded: !!gltfModel,
  }),
  extrude: () => btnExtrude.click(),
  bevel: () => btnBevel.click(),
  inset: () => btnInset.click(),
  subdivide: () => btnSubdivide.click(),
  undo: () => btnUndo.click(),
  redo: () => btnRedo.click(),
  toggleShader: () => btnToggleShader.click(),
  saveScene: () => btnSaveScene.click(),
  reloadScene: () => btnReloadScene.click(),
  recreate: () => btnRecreate.click(),
};

// Launch
ready(initStudio()).catch((err) => {
  console.error('Fatal initialization error:', err);
  log(`FATAL: ${err.message}`);
});
