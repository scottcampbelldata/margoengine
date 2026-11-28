// Showcase for DYN-01 rigid bodies and DYN-06 mass properties (docs/physics-parity-bar.md P1 and P2): 800 instanced
// boxes and spheres, one body per instance and two draw calls (InstancedBodies), fall onto heightfield terrain; a click
// casts a ray from the pointer and pushes the body it hits; the explosion button throws everything near the centre; and
// a row of single shapes shows the mass the solver computed from each one's density beside the closed-form value.
import { createStage, Geometry, PbrMaterial as StagePbr, box, sphere } from 'margoengine';
import { OrbitControls } from '@margoengine/controls/orbit';
import { Raycaster } from '@margoengine/bvh';
import { boxGeometry, capsuleGeometry, coneGeometry, cylinderGeometry, sphereGeometry } from '@margoengine/geometry';
import type { GeometryData } from '@margoengine/geometry';
import { createInstancedMesh, PbrMaterial } from '@margoengine/materials';
import { explosion, InstancedBodies, Physics, type ColliderOptions, type PhysicsBody } from '@margoengine/physics';
import { PhysicsDebugView } from '@margoengine/physics/debug-view';
import { demoStatus } from './demo-status.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const blastButton = document.querySelector<HTMLButtonElement>('#blast')!;
const dropButton = document.querySelector<HTMLButtonElement>('#drop')!;
const debugToggle = document.querySelector<HTMLInputElement>('#debug-view')!;
const bodiesEl = document.querySelector<HTMLElement>('#bodies')!;
const awakeEl = document.querySelector<HTMLElement>('#awake')!;
const pickEl = document.querySelector<HTMLElement>('#pick')!;
const backendEl = document.querySelector<HTMLElement>('#backend')!;
const massesEl = document.querySelector<HTMLTableSectionElement>('#masses')!;

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

// Terrain: a heightfield of rows by columns cells over SIZE metres, heights column major (row r, column c at
// r + (ROWS + 1) * c), centred on its body as the physics heightfield is.
const ROWS = 48,
  COLUMNS = 48,
  SIZE = 40;
const ground = (x: number, z: number): number =>
  1.6 * Math.sin(x * 0.18) * Math.cos(z * 0.15) + 0.7 * Math.sin(x * 0.41 + z * 0.33) - 0.04 * (x * x + z * z) * 0.1;
const heights = new Float32Array((ROWS + 1) * (COLUMNS + 1));
for (let c = 0; c <= COLUMNS; c++)
  for (let r = 0; r <= ROWS; r++)
    heights[r + (ROWS + 1) * c] = ground(-SIZE / 2 + (c * SIZE) / COLUMNS, -SIZE / 2 + (r * SIZE) / ROWS);

/** The drawn terrain: the same grid and the same diagonal split as the collider, so what you see is what bodies touch. */
function terrainGeometry(): Geometry {
  const n = (ROWS + 1) * (COLUMNS + 1),
    positions = new Float32Array(n * 3),
    normals = new Float32Array(n * 3),
    indices: number[] = [],
    dx = SIZE / COLUMNS,
    dz = SIZE / ROWS,
    at = (r: number, c: number): number => r + (ROWS + 1) * c;
  for (let c = 0; c <= COLUMNS; c++)
    for (let r = 0; r <= ROWS; r++) {
      const i = at(r, c),
        h = (rr: number, cc: number): number =>
          heights[at(Math.min(ROWS, Math.max(0, rr)), Math.min(COLUMNS, Math.max(0, cc)))]!;
      positions.set([-SIZE / 2 + c * dx, heights[i]!, -SIZE / 2 + r * dz], i * 3);
      const nx = (h(r, c - 1) - h(r, c + 1)) / (2 * dx),
        nz = (h(r - 1, c) - h(r + 1, c)) / (2 * dz),
        l = Math.hypot(nx, 1, nz);
      normals.set([nx / l, 1 / l, nz / l], i * 3);
    }
  // Each cell split along the diagonal from row r + 1, column c to row r, column c + 1, wound counter-clockwise from above.
  for (let c = 0; c < COLUMNS; c++)
    for (let r = 0; r < ROWS; r++)
      indices.push(at(r, c), at(r + 1, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1), at(r, c + 1));
  return new Geometry(positions, normals, indices);
}

/** A seeded generator (a 32-bit linear congruential one), so every load drops the same pile. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

try {
  await Physics.load();
  life.signal.throwIfAborted();
  const stage = await createStage(canvas, {
    controls: false,
    autoStart: false,
    backend: 'webgpu',
    background: '#131d24',
    capacity: 256,
    camera: { position: [0, 18, 30], target: [0, 1, 0], fov: 46, near: 0.1, far: 200 },
    onError: (err) => {
      if (!life.signal.aborted) page.error(err);
    },
  });
  const engine = stage.engine;
  engine.lighting.direction.set([5, 12, 6, 3.2]);
  engine.lighting.radiance.set([1, 0.97, 0.92, 0.3]);
  backendEl.textContent = document.documentElement.dataset.webgpuCompat !== undefined ? 'WebGL2 compat' : 'WebGPU';
  const controls = new OrbitControls(engine.camera, canvas);
  controls.target = [0, 1, 0];
  controls.minDistance = 6;
  controls.maxDistance = 70;
  controls.maxPolarAngle = Math.PI * 0.47;
  const physics = new Physics(engine, { fixedTimestep: 1 / 60 });

  const terrain = engine
    .createMesh()
    .setGeometry(terrainGeometry())
    .setMaterial(new StagePbr({ color: '#4f6b4a', roughness: 0.95 }));
  physics.addBody(terrain, {
    type: 'fixed',
    colliders: {
      shape: 'heightfield',
      rows: ROWS,
      columns: COLUMNS,
      heights,
      scale: [SIZE, 1, SIZE],
      fixInternalEdges: true,
    },
  });

  // Two instanced meshes, 400 instances each, and one body per instance.
  const COUNT = 400,
    random = seeded(7);
  const startPose = (i: number, out: Float32Array): void => {
    const x = (random() - 0.5) * 16,
      z = (random() - 0.5) * 16;
    out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, ground(x, z) + 4 + (i % 20) * 0.7 + random() * 2, z, 1]);
  };
  const pile = (geometry: GeometryData, colour: (i: number) => [number, number, number]) => {
    const mesh = createInstancedMesh(engine, geometry, new PbrMaterial({ roughness: 0.55 }), COUNT),
      m = new Float32Array(16);
    for (let i = 0; i < COUNT; i++) {
      startPose(i, m);
      mesh.instances.setMatrixAt(i, m).setColorAt(i, colour(i));
    }
    return mesh;
  };
  const crateMesh = pile(boxGeometry(0.6, 0.6, 0.6), (i) => [0.55 + (0.3 * ((i * 37) % 7)) / 7, 0.32, 0.12]);
  const ballMesh = pile(sphereGeometry(0.32, 20, 12), (i) => [0.12, 0.35 + (0.4 * ((i * 53) % 9)) / 9, 0.6]);
  const crates = new InstancedBodies(physics, crateMesh, {
    colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], density: 600, friction: 0.6 },
  });
  const balls = new InstancedBodies(physics, ballMesh, {
    colliders: { shape: 'sphere', radius: 0.32, density: 900, friction: 0.5, restitution: 0.3 },
    angularDamping: 0.4,
  });

  // A row of single shapes on the terrain, each from a density of 1000 kg/m³: the mass the solver computes from its
  // collider beside the closed-form mass of that solid.
  const RHO = 1000,
    r = 0.45,
    hh = 0.45;
  const shapes: { name: string; mesh: Geometry; collider: ColliderOptions; exact: number }[] = [
    {
      name: 'Box 0.9 m',
      mesh: box(0.9, 0.9, 0.9),
      collider: { shape: 'box', halfExtents: [0.45, 0.45, 0.45] },
      exact: RHO * 0.9 ** 3,
    },
    {
      name: 'Sphere r 0.45',
      mesh: sphere(r, 24),
      collider: { shape: 'sphere', radius: r },
      exact: RHO * (4 / 3) * Math.PI * r ** 3,
    },
    {
      name: 'Capsule',
      mesh: toGeometry(capsuleGeometry(r, 2 * hh, 6, 16)),
      collider: { shape: 'capsule', halfHeight: hh, radius: r },
      exact: RHO * (Math.PI * r * r * 2 * hh + (4 / 3) * Math.PI * r ** 3),
    },
    {
      name: 'Cylinder',
      mesh: toGeometry(cylinderGeometry(r, r, 2 * hh, 24)),
      collider: { shape: 'cylinder', halfHeight: hh, radius: r },
      exact: RHO * Math.PI * r * r * 2 * hh,
    },
    {
      name: 'Cone',
      mesh: toGeometry(coneGeometry(r, 2 * hh, 24)),
      collider: { shape: 'cone', halfHeight: hh, radius: r },
      exact: (RHO * Math.PI * r * r * 2 * hh) / 3,
    },
    {
      name: 'Convex hull (octahedron)',
      mesh: octahedron(0.6),
      collider: { shape: 'convexHull', points: [0.6, 0, 0, -0.6, 0, 0, 0, 0.6, 0, 0, -0.6, 0, 0, 0, 0.6, 0, 0, -0.6] },
      exact: (RHO * 4 * 0.6 ** 3) / 3,
    },
  ];
  const shapeMaterial = new StagePbr({ color: '#c9b27a', roughness: 0.4, metalness: 0.2 });
  const shapeBodies: PhysicsBody[] = shapes.map((s, i) => {
    const x = -7.5 + i * 3,
      z = 11,
      mesh = engine
        .createMesh()
        .setGeometry(s.mesh)
        .setMaterial(shapeMaterial)
        .setPosition([x, ground(x, z) + 1.5, z]);
    return physics.addBody(mesh, { colliders: { ...s.collider, density: RHO } });
  });
  massesEl.replaceChildren(
    ...shapes.map((s, i) => {
      const row = document.createElement('tr'),
        computed = shapeBodies[i]!.mass;
      for (const text of [s.name, `${computed.toFixed(1)} kg`, `${s.exact.toFixed(1)} kg`]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }),
  );
  bodiesEl.textContent = `${physics.bodyCount} in 2 instanced draws + ${shapes.length + 1}`;

  const debug = await PhysicsDebugView.attach(engine, physics, { enabled: false, world: { colliders: true } });

  const blast = (): void => {
    explosion(physics, [0, ground(0, 0), 0], { impulse: 9, radius: 12, lift: 0.6 });
  };
  const drop = (): void => {
    const m = new Float32Array(16);
    for (const group of [crates, balls])
      group.bodies.forEach((body, i) => {
        startPose(i, m);
        body.setPosition([m[12]!, m[13]!, m[14]!]).setRotation([0, 0, 0, 1]);
        body.setLinearVelocity([0, 0, 0]).setAngularVelocity([0, 0, 0]);
      });
  };

  // A click casts a ray from the pointer through the camera and pushes the dynamic body it hits along the ray.
  const raycaster = new Raycaster();
  canvas.addEventListener(
    'click',
    (event) => {
      raycaster.setFromEngine(engine, event.offsetX, event.offsetY);
      const origin: [number, number, number] = [raycaster.origin[0]!, raycaster.origin[1]!, raycaster.origin[2]!],
        direction: [number, number, number] = [
          raycaster.direction[0]!,
          raycaster.direction[1]!,
          raycaster.direction[2]!,
        ],
        hit = physics.raycast(origin, direction, { maxDistance: 200 });
      if (!hit || hit.body.type !== 'dynamic') {
        pickEl.textContent = hit ? 'the terrain' : 'nothing';
        return;
      }
      const crate = crates.bodies.indexOf(hit.body),
        ball = balls.bodies.indexOf(hit.body),
        name = crate >= 0 ? `crate ${crate}` : ball >= 0 ? `ball ${ball}` : 'a shape';
      hit.body.applyImpulseAtPoint(direction.map((d) => d * 6 * hit.body.mass) as [number, number, number], hit.point);
      pickEl.textContent = `${name}, ${hit.body.mass.toFixed(1)} kg, at ${hit.distance.toFixed(1)} m`;
    },
    { signal: life.signal },
  );

  stage.onTick((dt) => {
    controls.update(dt);
    let awake = 0;
    for (const group of [crates, balls]) for (const body of group.bodies) if (!body.sleeping) awake++;
    awakeEl.textContent = String(awake);
  });

  blastButton.addEventListener('click', blast, { signal: life.signal });
  dropButton.addEventListener('click', drop, { signal: life.signal });
  debugToggle.addEventListener('change', () => (debug.enabled = debugToggle.checked), { signal: life.signal });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'KeyE') blast();
      else if (e.code === 'KeyR') drop();
    },
    { signal: life.signal },
  );

  cleanup = () => {
    debug.dispose();
    crates.remove();
    balls.remove();
    controls.dispose();
    physics.dispose();
    stage.dispose();
  };
  for (const el of [blastButton, dropButton, debugToggle]) el.disabled = false;
  engine.start();
  page.ready('Ready: 800 instanced bodies fall onto the terrain. Click one to push it.');
} catch (cause) {
  page.error(cause);
}

/** A core Geometry from the geometry package's data (positions, normals and indices). */
function toGeometry(data: GeometryData): Geometry {
  return new Geometry(data.positions, data.normals, data.indices);
}

/** An octahedron with its six corners `a` from the centre, flat-shaded (each face its own three vertices). */
function octahedron(a: number): Geometry {
  const corners = [
      [a, 0, 0],
      [-a, 0, 0],
      [0, a, 0],
      [0, -a, 0],
      [0, 0, a],
      [0, 0, -a],
    ],
    faces = [
      [0, 2, 4],
      [4, 2, 1],
      [1, 2, 5],
      [5, 2, 0],
      [4, 3, 0],
      [1, 3, 4],
      [5, 3, 1],
      [0, 3, 5],
    ],
    positions: number[] = [],
    normals: number[] = [];
  for (const [i, j, k] of faces) {
    const p = corners[i!]!,
      q = corners[j!]!,
      s = corners[k!]!,
      n = [Math.sign(p[0]! + q[0]! + s[0]!), Math.sign(p[1]! + q[1]! + s[1]!), Math.sign(p[2]! + q[2]! + s[2]!)],
      l = Math.hypot(n[0]!, n[1]!, n[2]!);
    positions.push(...p, ...q, ...s);
    for (let v = 0; v < 3; v++) normals.push(n[0]! / l, n[1]! / l, n[2]! / l);
  }
  return new Geometry(
    positions,
    normals,
    Array.from({ length: 24 }, (_, i) => i),
  );
}
