// Dedicated showcase for @margoengine/physics/breakable (BREAK-01, X-42, X-43):
// Stone pillar, brick wall, and framed glass pane with click/Space cannonballs,
// pre-fractured vs impact-clustered Voronoi toggle, bond-strength slider, debug overlay, and reset.
import { createStage, PbrMaterial, box, sphere } from 'margoengine';
import { OrbitControls } from '@margoengine/controls/orbit';
import { Shadows } from '@margoengine/shadows';
import { Lines, Line, LineMaterial } from '@margoengine/lines';
import { Physics, type PhysicsBody } from '@margoengine/physics';
import { BreakableWorld, type BreakableBody, type BreakableFractureMode } from '@margoengine/physics/breakable';
import { demoStatus } from './demo-status.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const modeSelect = document.querySelector<HTMLSelectElement>('#mode')!;
const strengthSlider = document.querySelector<HTMLInputElement>('#strength')!;
const strengthValue = document.querySelector<HTMLOutputElement>('#strength-value')!;
const debugToggle = document.querySelector<HTMLInputElement>('#debug-view')!;
const shootButton = document.querySelector<HTMLButtonElement>('#shoot')!;
const blastButton = document.querySelector<HTMLButtonElement>('#blast')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!;
const brokenCountEl = document.querySelector<HTMLElement>('#broken-count')!;
const debrisCountEl = document.querySelector<HTMLElement>('#debris-count')!;
const lastImpulseEl = document.querySelector<HTMLElement>('#last-impulse')!;
const backendEl = document.querySelector<HTMLElement>('#backend')!;

const page = demoStatus(canvas, statusEl);
const life = new AbortController();
let cleanup = () => {};

window.addEventListener(
  'pagehide',
  () => {
    life.abort();
    cleanup();
  },
  { once: true },
);

interface StructureSpec {
  readonly baseStrength: number;
  readonly body: BreakableBody;
}

try {
  await Physics.load();
  life.signal.throwIfAborted();

  const stage = await createStage(canvas, {
    controls: false,
    autoStart: false,
    backend: 'webgpu',
    background: '#131d24',
    capacity: 2048,
    camera: {
      position: [0.4, 3.2, 10.5],
      target: [0.1, 1.5, 0],
      fov: 44,
      near: 0.1,
      far: 120,
    },
    onError: (err) => {
      if (!life.signal.aborted) page.error(err);
    },
  });

  const engine = stage.engine;
  engine.lighting.direction.set([6, 11, 7, 3.4]);
  engine.lighting.radiance.set([1, 0.97, 0.92, 0.22]);
  backendEl.textContent = document.documentElement.dataset.webgpuCompat !== undefined ? 'WebGL2 compat' : 'WebGPU';

  const shadows = Shadows.attach(engine, { resolution: 2048, distance: 32 });
  // OrbitControls takes its settings as properties: an options object as a third argument was dropped unread.
  const controls = new OrbitControls(engine.camera, canvas);
  controls.target = [0.1, 1.5, 0];
  controls.minDistance = 4;
  controls.maxDistance = 24;
  controls.maxPolarAngle = Math.PI * 0.485;

  const physics = new Physics(engine, {
    gravity: [0, -9.81, 0],
    fixedTimestep: 1 / 60,
  });
  const breakable = new BreakableWorld(physics, {
    engine,
    maxDebris: 120,
    debrisLifetime: 28,
    debrisSleepThreshold: 0.16,
    debrisAngularSleepThreshold: 0.28,
    debrisSleepTime: 0.35,
  });

  const linesPlugin = Lines.attach(engine);
  const debugMaterial = new LineMaterial({
    width: 2,
    vertexColors: true,
    colorMode: 'set',
    onTop: false,
    depthBias: 0.002,
  });
  let debugLine: Line | null = null;

  // Ground floor and architectural plinths.
  const floorMat = new PbrMaterial({
    color: '#3b4650',
    roughness: 0.88,
    metalness: 0.05,
  });
  const floorMesh = engine
    .createMesh()
    .setGeometry(box(28, 0.5, 22))
    .setMaterial(floorMat)
    .setPosition([0, -0.25, 0]);
  shadows.add(floorMesh, { static: true });
  physics.addBody(floorMesh, {
    type: 'fixed',
    colliders: { shape: 'box', halfExtents: [14, 0.25, 11], friction: 0.7 },
  });

  // Fixed dark steel frame around the glass pane on the right (x = 3.6, y = 1.25).
  const frameMat = new PbrMaterial({
    color: '#273038',
    roughness: 0.35,
    metalness: 0.75,
  });
  const frameParts: [number, number, number, number, number, number][] = [
    [3.6, 0.08, 0, 2.24, 0.16, 0.22],
    [3.6, 2.42, 0, 2.24, 0.16, 0.22],
    [2.54, 1.25, 0, 0.14, 2.34, 0.22],
    [4.66, 1.25, 0, 0.14, 2.34, 0.22],
  ];
  for (const [x, y, z, w, h, d] of frameParts) {
    const bar = engine
      .createMesh()
      .setGeometry(box(w, h, d))
      .setMaterial(frameMat)
      .setPosition([x, y, z]);
    shadows.add(bar, { static: true });
    physics.addBody(bar, {
      type: 'fixed',
      colliders: { shape: 'box', halfExtents: [w / 2, h / 2, d / 2] },
    });
  }

  // Distinct exterior and interior cut-face materials for each structure.
  const stoneExt = new PbrMaterial({
    color: '#bfb8aa',
    roughness: 0.82,
    metalness: 0.02,
  });
  const stoneInt = new PbrMaterial({
    color: '#8f8370',
    roughness: 0.95,
    metalness: 0.0,
  });
  const brickExt = new PbrMaterial({
    color: '#a84b36',
    roughness: 0.78,
    metalness: 0.02,
  });
  const brickInt = new PbrMaterial({
    color: '#d0a184',
    roughness: 0.92,
    metalness: 0.0,
  });
  const glassExt = new PbrMaterial({
    color: '#78d2e8',
    roughness: 0.08,
    metalness: 0.15,
  });
  const glassInt = new PbrMaterial({
    color: '#d4f6ff',
    roughness: 0.18,
    metalness: 0.2,
  });
  const ballMat = new PbrMaterial({
    color: '#2e353d',
    roughness: 0.28,
    metalness: 0.85,
  });
  const ballGeom = sphere(0.24, 20);

  const structures: StructureSpec[] = [];
  const intactMeshes: ReturnType<typeof engine.createMesh>[] = [];
  const projectiles: {
    body: PhysicsBody;
    mesh: ReturnType<typeof engine.createMesh>;
  }[] = [];

  let currentMode: BreakableFractureMode = 'prefractured';
  let strengthScale = 1;

  function clearProjectiles(): void {
    for (const p of projectiles) {
      if (p.body.valid) physics.removeBody(p.body);
      p.mesh.dispose();
    }
    projectiles.length = 0;
  }

  function buildStructures(mode: BreakableFractureMode): void {
    for (const s of structures) s.body.remove();
    structures.length = 0;
    for (const m of intactMeshes) m.dispose();
    intactMeshes.length = 0;
    clearProjectiles();
    lastImpulseEl.textContent = '—';

    // 1. Stone pillar (left): tall uniform Voronoi column anchored at base.
    const pillarMesh = engine
      .createMesh()
      .setGeometry(box(1.1, 3.4, 1.1))
      .setMaterial(stoneExt)
      .setPosition([-3.6, 1.7, 0]);
    shadows.add(pillarMesh);
    intactMeshes.push(pillarMesh);
    const pillarBase = 16;
    const pillar = breakable.add(pillarMesh, {
      size: [1.1, 3.4, 1.1],
      position: [-3.6, 1.7, 0],
      anchors: 'bottom',
      fractureMode: mode,
      pattern: 'uniform',
      cellCount: 16,
      seed: 101,
      bondStrength: pillarBase * strengthScale,
      minImpactImpulse: 2.5,
      density: 2.4,
      material: stoneExt,
      interiorMaterial: stoneInt,
    });
    structures.push({ baseStrength: pillarBase, body: pillar });

    // 2. Brick wall (center): staggered masonry courses anchored at bottom.
    const wallMesh = engine
      .createMesh()
      .setGeometry(box(3.2, 2.2, 0.45))
      .setMaterial(brickExt)
      .setPosition([0, 1.1, 0]);
    shadows.add(wallMesh);
    intactMeshes.push(wallMesh);
    const wallBase = 14;
    const wall = breakable.add(wallMesh, {
      size: [3.2, 2.2, 0.45],
      position: [0, 1.1, 0],
      anchors: 'bottom',
      fractureMode: mode,
      pattern: 'brick',
      cellCount: 20,
      seed: 202,
      bondStrength: wallBase * strengthScale,
      minImpactImpulse: 2.0,
      density: 1.9,
      material: brickExt,
      interiorMaterial: brickInt,
    });
    structures.push({ baseStrength: wallBase, body: wall });

    // 3. Framed glass pane (right): thin radial Voronoi pane anchored along its perimeter frame.
    const glassMesh = engine
      .createMesh()
      .setGeometry(box(1.98, 2.18, 0.08))
      .setMaterial(glassExt)
      .setPosition([3.6, 1.25, 0]);
    shadows.add(glassMesh);
    intactMeshes.push(glassMesh);
    const glassBase = 6;
    const glass = breakable.add(glassMesh, {
      size: [1.98, 2.18, 0.08],
      position: [3.6, 1.25, 0],
      anchors: 'perimeter',
      anchorTolerance: 0.08,
      fractureMode: mode,
      pattern: 'radial',
      cellCount: 18,
      seed: 303,
      bondStrength: glassBase * strengthScale,
      minImpactImpulse: 0.8,
      density: 1.2,
      restitution: 0.25,
      material: glassExt,
      interiorMaterial: glassInt,
    });
    structures.push({ baseStrength: glassBase, body: glass });
  }

  breakable.onBreak((event) => {
    lastImpulseEl.textContent = `${event.impulse.toFixed(1)} N·s (${event.fragments.length} pcs)`;
    for (const frag of event.fragments) {
      if (frag.mesh) shadows.add(frag.mesh);
    }
  });

  function rayFromPointer(
    clientX: number,
    clientY: number,
  ): { origin: [number, number, number]; dir: [number, number, number] } {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2;
    const cam = engine.camera;
    const fx = cam.target[0] - cam.position[0];
    const fy = cam.target[1] - cam.position[1];
    const fz = cam.target[2] - cam.position[2];
    const flen = Math.hypot(fx, fy, fz) || 1;
    const fwd: [number, number, number] = [fx / flen, fy / flen, fz / flen];
    const rx = fwd[1] * cam.up[2] - fwd[2] * cam.up[1];
    const ry = fwd[2] * cam.up[0] - fwd[0] * cam.up[2];
    const rz = fwd[0] * cam.up[1] - fwd[1] * cam.up[0];
    const rlen = Math.hypot(rx, ry, rz) || 1;
    const right: [number, number, number] = [rx / rlen, ry / rlen, rz / rlen];
    const up: [number, number, number] = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];
    const aspect = Math.max(0.1, rect.width / Math.max(1, rect.height));
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const dx = fwd[0] + right[0] * ndcX * aspect * tanHalf + up[0] * ndcY * tanHalf;
    const dy = fwd[1] + right[1] * ndcX * aspect * tanHalf + up[1] * ndcY * tanHalf;
    const dz = fwd[2] + right[2] * ndcX * aspect * tanHalf + up[2] * ndcY * tanHalf;
    const dlen = Math.hypot(dx, dy, dz) || 1;
    return {
      origin: [cam.position[0], cam.position[1], cam.position[2]],
      dir: [dx / dlen, dy / dlen, dz / dlen],
    };
  }

  function fireBall(origin: [number, number, number], dir: [number, number, number]): void {
    const start: [number, number, number] = [
      origin[0] + dir[0] * 0.9,
      origin[1] + dir[1] * 0.9,
      origin[2] + dir[2] * 0.9,
    ];
    const speed = 28;
    const mesh = engine.createMesh().setGeometry(ballGeom).setMaterial(ballMat).setPosition(start);
    shadows.add(mesh);
    const body = physics.addBody(mesh, {
      position: start,
      linearVelocity: [dir[0] * speed, dir[1] * speed, dir[2] * speed],
      ccd: true,
      colliders: {
        shape: 'sphere',
        radius: 0.24,
        density: 28,
        restitution: 0.25,
        contactForceEvents: true,
      },
    });
    projectiles.push({ body, mesh });
    if (projectiles.length > 18) {
      const oldest = projectiles.shift()!;
      if (oldest.body.valid) physics.removeBody(oldest.body);
      oldest.mesh.dispose();
    }
  }

  function fireForward(): void {
    const cam = engine.camera;
    const fx = cam.target[0] - cam.position[0];
    const fy = cam.target[1] - cam.position[1];
    const fz = cam.target[2] - cam.position[2];
    const len = Math.hypot(fx, fy, fz) || 1;
    fireBall([cam.position[0], cam.position[1], cam.position[2]], [fx / len, fy / len, fz / len]);
  }

  // Click (without orbit drag) fires a cannonball along the pointer ray.
  let downX = 0;
  let downY = 0;
  canvas.addEventListener(
    'pointerdown',
    (e) => {
      downX = e.clientX;
      downY = e.clientY;
    },
    { signal: life.signal },
  );
  canvas.addEventListener(
    'pointerup',
    (e) => {
      if (e.button !== 0) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      const { origin, dir } = rayFromPointer(e.clientX, e.clientY);
      fireBall(origin, dir);
    },
    { signal: life.signal },
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        fireForward();
      } else if (e.code === 'KeyR') {
        clearProjectiles();
        breakable.reset();
        lastImpulseEl.textContent = '—';
      } else if (e.code === 'KeyB') {
        breakable.applyExplosion([0, 1.4, 0.8], 75, 5.5, { lift: 0.35 });
      }
    },
    { signal: life.signal },
  );

  modeSelect.addEventListener(
    'change',
    () => {
      currentMode = modeSelect.value === 'impact' ? 'impact' : 'prefractured';
      buildStructures(currentMode);
    },
    { signal: life.signal },
  );

  strengthSlider.addEventListener(
    'input',
    () => {
      strengthScale = strengthSlider.valueAsNumber;
      strengthValue.textContent = `${strengthScale.toFixed(2)}×`;
      for (const s of structures) s.body.bondStrength = s.baseStrength * strengthScale;
    },
    { signal: life.signal },
  );

  shootButton.addEventListener('click', () => fireForward(), {
    signal: life.signal,
  });
  blastButton.addEventListener('click', () => breakable.applyExplosion([0, 1.4, 0.8], 75, 5.5, { lift: 0.35 }), {
    signal: life.signal,
  });
  resetButton.addEventListener(
    'click',
    () => {
      clearProjectiles();
      breakable.reset();
      lastImpulseEl.textContent = '—';
    },
    { signal: life.signal },
  );

  buildStructures(currentMode);

  function updateDebugOverlay(): void {
    if (!debugToggle.checked) {
      if (debugLine) {
        linesPlugin.remove(debugLine);
        debugLine.dispose();
        debugLine = null;
      }
      return;
    }
    const { vertices, colors } = breakable.debugRender({
      cells: true,
      bonds: true,
      anchors: true,
      debris: true,
    });
    if (vertices.length === 0) {
      if (debugLine) {
        linesPlugin.remove(debugLine);
        debugLine.dispose();
        debugLine = null;
      }
      return;
    }
    if (debugLine) {
      linesPlugin.remove(debugLine);
      debugLine.dispose();
    }
    debugLine = linesPlugin.add(
      new Line({
        mode: 'segments',
        positions: vertices,
        colors,
        material: debugMaterial,
      }),
    );
  }

  stage.onTick((dt) => {
    controls.update(dt);
    updateDebugOverlay();
    const broken = structures.filter((s) => s.body.broken).length;
    brokenCountEl.textContent = `${broken} / ${structures.length}`;
    debrisCountEl.textContent = String(breakable.debrisCount);
  });

  cleanup = () => {
    clearProjectiles();
    if (debugLine) {
      linesPlugin.remove(debugLine);
      debugLine.dispose();
      debugLine = null;
    }
    breakable.dispose();
    controls.dispose();
    stage.dispose();
  };

  for (const el of [modeSelect, strengthSlider, debugToggle, shootButton, blastButton, resetButton]) {
    el.disabled = false;
  }

  engine.start();
  page.ready('Ready — click or press Space to shoot.');
} catch (cause) {
  page.error(cause);
}
