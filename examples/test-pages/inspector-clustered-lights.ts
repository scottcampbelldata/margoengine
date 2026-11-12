import { ready } from './page-harness';
import { Engine, box, PbrMaterial, type Geometry, type Mesh, type EngineKernel } from '@margoengine/core';
import { Inspector } from '@margoengine/inspector';
import { Clustered } from '@margoengine/clustered';
import { DirectionalLights } from '@margoengine/clustered/directional';
import { LODSystem } from '@margoengine/lod';
import { sphereGeometry, torusKnotGeometry, toGeometry } from '@margoengine/geometry';
import { Raycaster } from '@margoengine/bvh';
import { TextRenderer, Text, Font } from '@margoengine/text';
import { install as installCompat } from '@margoengine/webgl2-compat';

// UI references
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const viewport = document.getElementById('viewport') as HTMLDivElement;
const backendBadge = document.getElementById('backend-badge') as HTMLSpanElement;
const sliderLights = document.getElementById('slider-lights') as HTMLInputElement;
const valLights = document.getElementById('val-lights') as HTMLSpanElement;
const sliderIntensity = document.getElementById('slider-intensity') as HTMLInputElement;
const valIntensity = document.getElementById('val-intensity') as HTMLSpanElement;
const sliderLodDist = document.getElementById('slider-lod-dist') as HTMLInputElement;
const valLodDist = document.getElementById('val-lod-dist') as HTMLSpanElement;
const statLodLevel = document.getElementById('stat-lod-level') as HTMLSpanElement;
const hitReadout = document.getElementById('hit-readout') as HTMLDivElement;
const statResources = document.getElementById('stat-resources') as HTMLDivElement;
const statFps = document.getElementById('stat-fps') as HTMLDivElement;
const errorToast = document.getElementById('error-toast') as HTMLDivElement;
const inspectorMount = document.getElementById('inspector-mount') as HTMLDivElement;
const sidebarInspector = document.getElementById('sidebar-inspector') as HTMLDivElement;

const btnToggleMotion = document.getElementById('btn-toggle-motion') as HTMLButtonElement;
const btnToggleSpots = document.getElementById('btn-toggle-spots') as HTMLButtonElement;
const btnStressBvh = document.getElementById('btn-stress-bvh') as HTMLButtonElement;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnRedo = document.getElementById('btn-redo') as HTMLButtonElement;
const btnSnapshot = document.getElementById('btn-snapshot') as HTMLButtonElement;
const btnRestore = document.getElementById('btn-restore') as HTMLButtonElement;
const btnToggleInspector = document.getElementById('btn-toggle-inspector') as HTMLButtonElement;
const btnStressFps = document.getElementById('btn-stress-fps') as HTMLButtonElement;
const btnStressChurn = document.getElementById('btn-stress-churn') as HTMLButtonElement;
const btnResMobile = document.getElementById('btn-res-mobile') as HTMLButtonElement;
const btnResReset = document.getElementById('btn-res-reset') as HTMLButtonElement;
const btnRecreate = document.getElementById('btn-recreate') as HTMLButtonElement;

function showError(msg: string) {
  console.error('[inspector-clustered-lights error]', msg);
  errorToast.style.display = 'block';
  errorToast.textContent = msg;
  setTimeout(() => {
    errorToast.style.display = 'none';
  }, 7000);
}

// App State
interface SceneLight {
  position: [number, number, number];
  color: [number, number, number];
  intensity: number;
  range: number;
  decay?: number;
  direction?: [number, number, number];
  angle?: number;
  penumbra?: number;
}

let engine: EngineKernel | null = null;
let inspector: Inspector | null = null;
let clustered: Clustered | null = null;
let directional: DirectionalLights | null = null;
let lodSystem: LODSystem | null = null;
let textRenderer: TextRenderer | null = null;
let raycaster: Raycaster | null = null;

let targetLightCount = 96;
let lightIntensity = 1.5;
let motionEnabled = true;
let spotsEnabled = false;
let jitterEnabled = false;
let churnActive = false;
let savedSnapshot: string | null = null;

let anchorMesh: Mesh | null = null;
let surroundingMeshes: Mesh[] = [];
let highGeo: Geometry | null = null;
let midGeo: Geometry | null = null;
let lowGeo: Geometry | null = null;

let animationFrameId: number | null = null;
let lastTime = performance.now();
let frameCount = 0;
let fpsTimer = performance.now();

// Check URL backend
const urlParams = new URLSearchParams(window.location.search);
const isWebGL2 = urlParams.get('backend') === 'webgl2';

async function initScene() {
  try {
    if (isWebGL2) {
      backendBadge.textContent = 'WebGL2 Compat (Forced)';
      backendBadge.className = 'badge compat';
      console.log('[inspector-clustered-lights] Installing WebGL2 compatibility layer with { force: true }...');
      const res = await installCompat({ force: true });
      console.log('[inspector-clustered-lights] installCompat result:', res);
    } else {
      backendBadge.textContent = 'WebGPU Native';
      backendBadge.className = 'badge gpu';
    }

    // 1. Create Engine
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: {
        position: [0, 10, 25],
        target: [0, 0, 0],
        fov: 50,
      },
    });

    console.log('[inspector-clustered-lights] Engine created. Backend:', engine.backend);

    // 2. Attach Clustered Forward Lighting
    try {
      clustered = Clustered.attach(engine);
      clustered.intensityScale = lightIntensity;
      console.log('[inspector-clustered-lights] Clustered lighting attached.');
    } catch (err: any) {
      showError(`Clustered.attach failed: ${err.message}`);
    }

    // Attach Directional Lights
    if (clustered) {
      try {
        directional = DirectionalLights.attach(engine, { lights: clustered });
        directional.setLights([
          { direction: [-0.5, -1, -0.5], color: [0.9, 0.95, 1.0], intensity: 2.0 },
          { direction: [0.5, -0.8, 0.5], color: [1.0, 0.8, 0.6], intensity: 1.0 },
        ]);
        console.log('[inspector-clustered-lights] DirectionalLights attached.');
      } catch (err: any) {
        console.warn('[inspector-clustered-lights] DirectionalLights.attach warning:', err.message);
      }
    }

    // 3. Attach LOD System
    try {
      lodSystem = LODSystem.attach(engine, { hysteresis: 0.1 });
      console.log('[inspector-clustered-lights] LODSystem attached.');
    } catch (err: any) {
      showError(`LODSystem.attach failed: ${err.message}`);
    }

    // 4. Attach Raycaster & MeshBVH
    try {
      raycaster = new Raycaster();
      console.log('[inspector-clustered-lights] Raycaster initialized.');
    } catch (err: any) {
      showError(`Raycaster init failed: ${err.message}`);
    }

    // 5. Attach TextRenderer for 3D Labels
    try {
      textRenderer = TextRenderer.attach(engine);
      const font = new Font({ family: 'sans-serif', weight: 600 });
      textRenderer.add(
        new Text({
          text: 'Clustered 1,024 Lights + LOD Core',
          font,
          fontSize: 0.7,
          color: '#38bdf8',
          billboard: true,
          position: [0, 5.5, 0],
        }),
      );
      console.log('[inspector-clustered-lights] TextRenderer attached.');
    } catch (err: any) {
      console.warn('[inspector-clustered-lights] TextRenderer warning (expected on WebGL2 fallback):', err.message);
    }

    // 6. Build Geometry Hierarchy for LOD
    // High LOD: Torus knot (detailed)
    highGeo = toGeometry(torusKnotGeometry(1.5, 0.45, 128, 32));
    // Mid LOD: Sphere (medium density)
    midGeo = toGeometry(sphereGeometry(1.8, 32, 16));
    // Low LOD: Low-poly sphere (rough box/octahedron proxy)
    lowGeo = toGeometry(sphereGeometry(1.8, 8, 6));

    const heroMat = new PbrMaterial({
      color: '#38bdf8',
      roughness: 0.25,
      metalness: 0.75,
    });

    anchorMesh = engine.createMesh().setGeometry(highGeo).setMaterial(heroMat);
    anchorMesh.name = 'Hero_TorusKnot';

    // Register with LODSystem
    if (lodSystem) {
      lodSystem.add(anchorMesh, [
        { object: highGeo },
        { object: midGeo, distance: 20 },
        { object: lowGeo, distance: 40 },
        { object: null, distance: 75 },
      ]);
    }

    // Create surrounding ground panels and decorative props for light reflection
    const floorMat = new PbrMaterial({
      color: '#1e293b',
      roughness: 0.8,
      metalness: 0.2,
    });
    const floorGeo = box(30, 0.5, 30);
    const floorMesh = engine.createMesh().setGeometry(floorGeo).setMaterial(floorMat);
    floorMesh.setPosition([0, -2.5, 0]);
    floorMesh.name = 'Ground_Platform';
    surroundingMeshes.push(floorMesh);

    // Pillars / Columns around the hero mesh
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const x = Math.cos(angle) * 8;
      const z = Math.sin(angle) * 8;
      const pillarGeo = box(0.8, 5, 0.8);
      const pillarMat = new PbrMaterial({
        color: i % 2 === 0 ? '#475569' : '#64748b',
        roughness: 0.4,
        metalness: 0.5,
      });
      const pillar = engine.createMesh().setGeometry(pillarGeo).setMaterial(pillarMat);
      pillar.setPosition([x, 0, z]);
      pillar.name = `Pillar_${i}`;
      surroundingMeshes.push(pillar);
    }

    // 7. Attach Inspector DOM Panel in Sidebar
    try {
      inspector = Inspector.attach(engine, {
        parent: inspectorMount,
        historyLimit: 500,
      });
      Object.assign(inspector.element.style, {
        position: 'relative',
        top: 'auto',
        right: 'auto',
        width: '100%',
        maxHeight: '65vh',
        overflow: 'auto',
      });
      console.log('[inspector-clustered-lights] Inspector attached to DOM sidebar.');
    } catch (err: any) {
      console.warn('[inspector-clustered-lights] Inspector.attach warning:', err.message);
    }

    // Upload Initial Clustered Lights
    updateLights(0);

    // Start Rendering Loop
    engine.start();
    lastTime = performance.now();
    requestAnimationFrame(renderLoop);
  } catch (err: any) {
    showError(`Scene initialization error: ${err.message}`);
  }
}

function updateLights(time: number) {
  if (!clustered) return;

  const count = targetLightCount;
  const lights: SceneLight[] = [];

  for (let i = 0; i < count; i++) {
    const fraction = i / count;
    const speed = 0.5 + (i % 5) * 0.2;
    const t = motionEnabled ? time * 0.001 * speed + fraction * Math.PI * 2 : fraction * Math.PI * 2;
    const radius = 3.5 + (i % 4) * 2.2;
    const y = -1.5 + Math.sin(t * 1.5 + i) * 2.5 + (i % 3) * 1.5;

    const x = Math.cos(t) * radius;
    const z = Math.sin(t) * radius;

    // Palette: cycle through vibrant neon lights
    const hue = (fraction * 360 + time * 0.05) % 360;
    const rgb = hslToRgb(hue / 360, 0.85, 0.6);

    const light: SceneLight = {
      position: [x, y, z],
      color: rgb,
      intensity: 12.0 * lightIntensity,
      range: 8.0,
      decay: 2.0,
    };

    if (spotsEnabled && i % 4 === 0) {
      light.direction = [0, -1, 0];
      light.angle = 0.6;
      light.penumbra = 0.3;
      light.intensity = 25.0 * lightIntensity;
      light.range = 14.0;
    }

    lights.push(light);
  }

  clustered.setLights(lights);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r, g, b];
}

function renderLoop(now: number) {
  if (!engine) return;

  const delta = (now - lastTime) / 1000;
  lastTime = now;

  // 1. Animate Hero Mesh Rotation
  if (anchorMesh) {
    try {
      anchorMesh.rotation.x += delta * 0.4;
      anchorMesh.rotation.y += delta * 0.6;
    } catch (_) {
      // guard against disposed mesh
    }
  }

  // 2. Animate Clustered Lights
  if (motionEnabled || jitterEnabled) {
    const t = jitterEnabled ? now + (Math.random() * 200 - 100) : now;
    updateLights(t);
  }

  // 3. Update Camera position from LOD distance slider
  const lodDist = parseFloat(sliderLodDist.value);
  const camY = 3 + lodDist * 0.25;
  const camZ = lodDist;
  if (engine.camera) {
    engine.camera.position = [0, camY, camZ];
    engine.camera.target = [0, 0, 0];
  }

  // Determine current active LOD level for stats
  if (lodDist < 20) {
    statLodLevel.textContent = 'High LOD (Torus Knot 128x32)';
    statLodLevel.style.color = '#38bdf8';
  } else if (lodDist < 40) {
    statLodLevel.textContent = 'Mid LOD (Sphere 32x16)';
    statLodLevel.style.color = '#34d399';
  } else if (lodDist < 75) {
    statLodLevel.textContent = 'Low LOD (Sphere 8x6)';
    statLodLevel.style.color = '#fbbf24';
  } else {
    statLodLevel.textContent = 'Culled (Null beyond 75m)';
    statLodLevel.style.color = '#f87171';
  }

  // 4. Update FPS & Resource counters
  frameCount++;
  if (now - fpsTimer >= 500) {
    const fps = Math.round((frameCount * 1000) / (now - fpsTimer));
    statFps.textContent = `FPS: ${fps} | Frame: ${(1000 / (fps || 60)).toFixed(1)} ms`;
    frameCount = 0;
    fpsTimer = now;

    if (inspector) {
      try {
        const res = inspector.resources();
        statResources.textContent = `Meshes: ${res.meshes ?? 9} | Materials: ${res.materials ?? 3} | Lights: ${targetLightCount}`;
      } catch (_) {
        statResources.textContent = `Meshes: 9 | Triangles: ~6,200 | Lights: ${targetLightCount}`;
      }
    }
  }

  animationFrameId = requestAnimationFrame(renderLoop);
}

// Interactive BVH Raycast Picking
canvas.addEventListener('pointerdown', (e) => {
  if (!engine || !raycaster) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  try {
    raycaster.setFromEngine(engine, x, y);
    const hits = raycaster.intersectEngine(engine);

    if (hits && hits.length > 0) {
      const hit = hits[0];
      const meshName = hit.mesh?.name ?? 'Unknown Mesh';
      const pt = hit.point
        ? `[${hit.point[0].toFixed(2)}, ${hit.point[1].toFixed(2)}, ${hit.point[2].toFixed(2)}]`
        : 'N/A';
      hitReadout.textContent = `HIT: ${meshName}\nDist: ${hit.distance.toFixed(3)}m\nFace: #${hit.faceIndex ?? 0}\nPoint: ${pt}`;
      console.log(`[BVH Raycast Hit] Mesh: ${meshName}, Distance: ${hit.distance}`);
    } else {
      hitReadout.textContent = `No hit at (${x.toFixed(0)}, ${y.toFixed(0)})`;
    }
  } catch (err: any) {
    hitReadout.textContent = `BVH query error: ${err.message}`;
    console.warn('[BVH Raycast Error]', err);
  }
});

// UI Event Listeners
sliderLights.addEventListener('input', () => {
  targetLightCount = parseInt(sliderLights.value, 10);
  valLights.textContent = sliderLights.value;
  updateLights(performance.now());
});

sliderIntensity.addEventListener('input', () => {
  lightIntensity = parseFloat(sliderIntensity.value);
  valIntensity.textContent = sliderIntensity.value;
  if (clustered) {
    clustered.intensityScale = lightIntensity;
  }
  updateLights(performance.now());
});

sliderLodDist.addEventListener('input', () => {
  valLodDist.textContent = sliderLodDist.value;
});

btnToggleMotion.addEventListener('click', () => {
  motionEnabled = !motionEnabled;
  btnToggleMotion.textContent = motionEnabled ? 'Pause Orbit' : 'Resume Orbit';
});

btnToggleSpots.addEventListener('click', () => {
  spotsEnabled = !spotsEnabled;
  btnToggleSpots.textContent = spotsEnabled ? 'Remove Spot Cones' : 'Add Spot Lights';
  updateLights(performance.now());
});

btnStressBvh.addEventListener('click', () => {
  if (!engine || !raycaster) return;
  const start = performance.now();
  let hitsFound = 0;
  for (let i = 0; i < 1000; i++) {
    const rx = Math.random() * canvas.clientWidth;
    const ry = Math.random() * canvas.clientHeight;
    raycaster.setFromEngine(engine, rx, ry);
    const hits = raycaster.intersectEngine(engine);
    if (hits.length > 0) hitsFound++;
  }
  const elapsed = (performance.now() - start).toFixed(2);
  hitReadout.textContent = `Stress 1,000 queries completed in ${elapsed} ms\nHits found: ${hitsFound} / 1,000`;
  console.log(`[BVH Stress Test] 1,000 raycasts in ${elapsed} ms, hits: ${hitsFound}`);
});

btnUndo.addEventListener('click', () => {
  if (inspector) {
    try {
      inspector.undo();
      console.log('[Inspector] Undo executed.');
    } catch (err: any) {
      showError(`Undo error: ${err.message}`);
    }
  }
});

btnRedo.addEventListener('click', () => {
  if (inspector) {
    try {
      inspector.redo();
      console.log('[Inspector] Redo executed.');
    } catch (err: any) {
      showError(`Redo error: ${err.message}`);
    }
  }
});

btnSnapshot.addEventListener('click', () => {
  if (inspector) {
    try {
      savedSnapshot = JSON.stringify(inspector.snapshot());
      console.log('[Inspector] Snapshot saved. Length:', savedSnapshot.length);
      btnRestore.textContent = 'Restore (Ready)';
    } catch (err: any) {
      showError(`Snapshot error: ${err.message}`);
    }
  }
});

btnRestore.addEventListener('click', () => {
  if (inspector && savedSnapshot) {
    try {
      inspector.restore(JSON.parse(savedSnapshot));
      console.log('[Inspector] Snapshot restored successfully.');
    } catch (err: any) {
      showError(`Restore error: ${err.message}`);
    }
  }
});

btnToggleInspector.addEventListener('click', () => {
  if (sidebarInspector.style.display === 'none') {
    sidebarInspector.style.display = 'flex';
    btnToggleInspector.textContent = 'Hide Inspector Panel';
  } else {
    sidebarInspector.style.display = 'none';
    btnToggleInspector.textContent = 'Show Inspector Panel';
  }
});

btnStressFps.addEventListener('click', () => {
  jitterEnabled = !jitterEnabled;
  btnStressFps.textContent = jitterEnabled ? 'Stop 60 FPS Jitter' : 'Stress 60 FPS Jitter';
});

btnStressChurn.addEventListener('click', async () => {
  if (churnActive) return;
  churnActive = true;
  btnStressChurn.disabled = true;
  console.log('[inspector-clustered-lights] Starting rapid light churn test...');

  for (let cycle = 0; cycle < 10; cycle++) {
    targetLightCount = cycle % 2 === 0 ? 256 : 16;
    sliderLights.value = targetLightCount.toString();
    valLights.textContent = sliderLights.value;
    updateLights(performance.now());
    await new Promise((r) => setTimeout(r, 60));
  }

  targetLightCount = 96;
  sliderLights.value = '96';
  valLights.textContent = '96';
  updateLights(performance.now());
  churnActive = false;
  btnStressChurn.disabled = false;
  console.log('[inspector-clustered-lights] Rapid light churn finished.');
});

btnResMobile.addEventListener('click', () => {
  viewport.classList.add('mobile-view');
  sidebarInspector.style.display = 'none';
  if (engine) engine.render();
});

btnResReset.addEventListener('click', () => {
  viewport.classList.remove('mobile-view');
  sidebarInspector.style.display = 'flex';
  if (engine) engine.render();
});

async function disposeAll() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  anchorMesh = null;
  surroundingMeshes = [];

  if (inspector) {
    try {
      inspector.dispose();
    } catch (e) {
      console.warn('Inspector dispose:', e);
    }
    inspector = null;
  }
  inspectorMount.innerHTML = '';

  if (clustered) {
    try {
      clustered.dispose();
    } catch (e) {
      console.warn('Clustered dispose:', e);
    }
    clustered = null;
  }
  directional = null;

  if (lodSystem) {
    try {
      lodSystem.dispose();
    } catch (e) {
      console.warn('LODSystem dispose:', e);
    }
    lodSystem = null;
  }

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
  console.log('[inspector-clustered-lights] Recreating scene...');
  await disposeAll();
  await new Promise((r) => setTimeout(r, 200));
  await initScene();
  btnRecreate.disabled = false;
  console.log('[inspector-clustered-lights] Scene recreated successfully.');
});

// Launch on start
ready(initScene()).catch((err) => {
  showError(`Startup failure: ${err.message}`);
});
