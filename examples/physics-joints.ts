// Showcase for DYN-03 joints and motors (docs/physics-parity-bar.md P3): a door on a hinge with a stop and a motor, a
// three-link arm held as a multibody with position motors, and a chain of ball joints with a swing limit on each link,
// drawn with the joint debug view (frames and limits).
import { createStage, PbrMaterial, box } from 'margoengine';
import { OrbitControls } from '@margoengine/controls/orbit';
import { Shadows } from '@margoengine/shadows';
import { Lines, Line, LineMaterial } from '@margoengine/lines';
import { Physics, type PhysicsBody } from '@margoengine/physics';
import { demoStatus } from './demo-status.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const doorButton = document.querySelector<HTMLButtonElement>('#door')!;
const kickButton = document.querySelector<HTMLButtonElement>('#kick')!;
const debugToggle = document.querySelector<HTMLInputElement>('#debug-view')!;
const doorAngleEl = document.querySelector<HTMLElement>('#door-angle')!;
const armAnglesEl = document.querySelector<HTMLElement>('#arm-angles')!;
const jointCountEl = document.querySelector<HTMLElement>('#joint-count')!;
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

try {
  await Physics.load();
  life.signal.throwIfAborted();
  const stage = await createStage(canvas, {
    controls: false,
    autoStart: false,
    backend: 'webgpu',
    background: '#131d24',
    capacity: 256,
    camera: { position: [0.5, 3.2, 9], target: [0, 1.6, 0], fov: 44, near: 0.1, far: 80 },
    onError: (err) => {
      if (!life.signal.aborted) page.error(err);
    },
  });
  const engine = stage.engine;
  engine.lighting.direction.set([6, 11, 7, 3.4]);
  engine.lighting.radiance.set([1, 0.97, 0.92, 0.22]);
  backendEl.textContent = document.documentElement.dataset.webgpuCompat !== undefined ? 'WebGL2 compat' : 'WebGPU';
  const shadows = Shadows.attach(engine, { resolution: 2048, distance: 24 });
  const controls = new OrbitControls(engine.camera, canvas);
  controls.target = [0, 1.6, 0];
  controls.minDistance = 3;
  controls.maxDistance = 20;
  controls.maxPolarAngle = Math.PI * 0.485;
  const physics = new Physics(engine, { fixedTimestep: 1 / 60 });
  const linesPlugin = Lines.attach(engine);
  const debugMaterial = new LineMaterial({ width: 2, vertexColors: true, colorMode: 'set', onTop: true });
  let debugLine: Line | null = null;

  const steel = new PbrMaterial({ color: '#59646e', roughness: 0.4, metalness: 0.8 });
  const wood = new PbrMaterial({ color: '#a4774f', roughness: 0.7, metalness: 0 });
  const paint = new PbrMaterial({ color: '#e0a03a', roughness: 0.45, metalness: 0.1 });
  const link = new PbrMaterial({ color: '#b9c3c9', roughness: 0.3, metalness: 0.9 });
  /** A box mesh and its body: the body moves the mesh. */
  const block = (
    size: [number, number, number],
    position: [number, number, number],
    material: PbrMaterial,
    type: 'fixed' | 'dynamic' = 'dynamic',
    mass?: number,
  ): PhysicsBody => {
    const mesh = engine.createMesh().setGeometry(box(...size)).setMaterial(material).setPosition(position);
    shadows.add(mesh, { static: type === 'fixed' });
    const halfExtents: [number, number, number] = [size[0] / 2, size[1] / 2, size[2] / 2];
    return physics.addBody(mesh, { type, colliders: { shape: 'box', halfExtents, ...(mass ? { mass } : {}) } });
  };

  block([16, 0.4, 10], [0, -0.2, 0], new PbrMaterial({ color: '#3b4650', roughness: 0.9 }), 'fixed');

  // A door on a hinge: a stop at 0 and at 1.7 rad, and a velocity motor with a force cap that swings it either way.
  const jamb = block([0.12, 2.2, 0.12], [-4.2, 1.1, 0], steel, 'fixed');
  const door = block([1.1, 2, 0.05], [-3.59, 1.1, 0], wood, 'dynamic', 20);
  const hinge = physics.addJoint(jamb, door, {
    type: 'revolute',
    axis: [0, 1, 0],
    anchorA: [0.06, 0, 0],
    anchorB: [-0.55, 0, 0],
    limits: [0, 1.7],
    motor: { targetVelocity: 1.2, damping: 400, model: 'force', maxForce: 60 },
  });
  let opening = true;
  const swingDoor = (): void => {
    opening = !opening;
    hinge.setMotor({ targetVelocity: opening ? 1.2 : -1.2, damping: 400, model: 'force', maxForce: 60 });
    doorButton.textContent = opening ? 'Close the door (D)' : 'Open the door (D)';
  };

  // A three-link arm as a multibody (reduced coordinates), each hinge a position motor toward a moving target.
  const base = block([0.5, 0.3, 0.5], [0, 0.15, 0], steel, 'fixed');
  const sizes: [number, number, number][] = [
    [0.18, 1, 0.18],
    [0.15, 0.9, 0.15],
    [0.12, 0.6, 0.12],
  ];
  let height = 0.3;
  const segments = sizes.map((size) => {
    const body = block(size, [0, height + size[1] / 2, 0], paint, 'dynamic', 2);
    height += size[1];
    return body;
  });
  const arm = physics.addMultibody(
    base,
    segments.map((body, i) => ({
      body,
      parent: i === 0 ? base : segments[i - 1]!,
      joint: {
        type: 'revolute' as const,
        axis: (i === 0 ? [0, 1, 0] : [0, 0, 1]) as [number, number, number],
        anchorA: (i === 0 ? [0, 0.15, 0] : [0, sizes[i - 1]![1] / 2, 0]) as [number, number, number],
        anchorB: [0, -sizes[i]![1] / 2, 0] as [number, number, number],
        limits: (i === 0 ? [-2.5, 2.5] : [-1.4, 1.4]) as [number, number],
      },
    })),
  );
  const armTarget = (t: number): number[] => [1.6 * Math.sin(0.4 * t), 0.7 * Math.sin(0.7 * t), 1.1 * Math.sin(0.9 * t + 1)];

  // A chain of twelve links on ball joints from a beam, each swing held to 0.6 rad about each cross axis.
  const beam = block([0.2, 0.2, 2.4], [3.6, 4.2, 0], steel, 'fixed');
  const links: PhysicsBody[] = [];
  for (let i = 0; i < 12; i++) {
    const body = block([0.08, 0.26, 0.08], [3.6, 4.2 - 0.1 - 0.13 - i * 0.26, 0], link, 'dynamic', 0.5);
    physics.addJoint(i === 0 ? beam : links[i - 1]!, body, {
      type: 'spherical',
      anchorA: i === 0 ? [0, -0.1, 0] : [0, -0.13, 0],
      anchorB: [0, 0.13, 0],
      limits: { angX: [-0.6, 0.6], angZ: [-0.6, 0.6] },
    });
    links.push(body);
  }
  const weight = block([0.3, 0.3, 0.3], [3.6, 4.2 - 0.1 - 12 * 0.26 - 0.15, 0], steel, 'dynamic', 4);
  physics.addJoint(links[11]!, weight, { type: 'spherical', anchorA: [0, -0.13, 0], anchorB: [0, 0.15, 0] });
  const kick = (): void => {
    weight.applyImpulse([6, 0, 4]);
  };
  jointCountEl.textContent = String(physics.jointCount);

  const showDebug = (): void => {
    if (debugLine) {
      linesPlugin.remove(debugLine);
      debugLine.dispose();
      debugLine = null;
    }
    if (!debugToggle.checked) return;
    const { vertices, colors } = physics.debugRender({ colliders: false, contacts: false, jointFrames: true });
    if (vertices.length) debugLine = linesPlugin.add(new Line({ mode: 'segments', positions: vertices, colors, material: debugMaterial }));
  };

  let time = 0;
  stage.onTick((dt) => {
    controls.update(dt);
    time += dt;
    armTarget(time).forEach((angle, i) =>
      arm.links[i]!.joint.setMotor({ targetPosition: angle, frequency: 2.5, dampingRatio: 1, maxForce: 400 }),
    );
    showDebug();
    const doorRotation = door.rotation;
    doorAngleEl.textContent = `${(2 * Math.atan2(doorRotation[1], doorRotation[3])).toFixed(2)} rad`;
    armAnglesEl.textContent = arm.coordinates().map((v) => v.toFixed(2)).join(' / ');
  });

  doorButton.addEventListener('click', swingDoor, { signal: life.signal });
  kickButton.addEventListener('click', kick, { signal: life.signal });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'KeyD') swingDoor();
      else if (e.code === 'KeyK') kick();
    },
    { signal: life.signal },
  );

  cleanup = () => {
    if (debugLine) {
      linesPlugin.remove(debugLine);
      debugLine.dispose();
    }
    controls.dispose();
    physics.dispose();
    stage.dispose();
  };
  for (const el of [doorButton, kickButton, debugToggle]) el.disabled = false;
  engine.start();
  page.ready('Ready: the door swings open, the arm follows its targets, the chain hangs.');
} catch (cause) {
  page.error(cause);
}
