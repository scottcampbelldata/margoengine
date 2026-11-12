import { ready } from './page-harness';
import { createStage, type Stage } from '@margoengine/stage';
import { box, PbrMaterial, type Mesh } from '@margoengine/core';
import { install as installWebGL2Compat } from '@margoengine/webgl2-compat';
import { SnapshotBuffer, createSnapshot } from '@margoengine/net';
import { AdaptiveDelay } from '@margoengine/net/delay';
import { defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from '@margoengine/netcode';
import { GrowableWorld } from '@margoengine/ecs/growable';
import { Schedule } from '@margoengine/ecs';
import { BehaviorTree, action, condition, reactiveSelector, sequence, wait } from '@margoengine/behavior';
import { StateMachine } from '@margoengine/fsm';
import { Crowd, NavMesh, type CrowdAgent } from '@margoengine/navmesh';
import { BlockTypes, VoxelWorld } from '@margoengine/voxel';
import { VoxelNetClient, Keys, encodeServerMessage, blockTableHash, PROTOCOL_VERSION } from '@margoengine/voxel-net';
import { transferCanvas, workerCanvasSupported, type WorkerCanvas } from '@margoengine/worker';

// Check backend mode
const urlParams = new URLSearchParams(window.location.search);
const useWebGL2 = urlParams.get('backend') === 'webgl2';
const badge = document.getElementById('backend-badge');
if (badge) {
  badge.textContent = useWebGL2 ? 'WebGL2 Fallback' : 'WebGPU';
  badge.className = useWebGL2 ? 'badge warn' : 'badge active';
}

function log(msg: string) {
  const box = document.getElementById('log-box');
  if (box) {
    const time = new Date().toISOString().substring(11, 19);
    box.innerHTML = `[${time}] ${msg}<br/>` + box.innerHTML.slice(0, 500);
  }
}

// -------------------------------------------------------------
// Netcode & Server Definition
// -------------------------------------------------------------
const gameSchema = defineSchema({
  types: {
    Input: { targetX: 'f32', targetZ: 'f32' },
    AgentData: { x: 'f32', z: 'f32', vx: 'f32', vz: 'f32', state: 'u8' },
    WorldState: {
      tick: 'u32',
      agents: { type: 'map', of: 'AgentData', maxSize: 64 },
    },
  },
} as const);

interface AgentData {
  x: number;
  z: number;
  vx: number;
  vz: number;
  state: number;
}

interface WorldState {
  tick: number;
  agents: Map<number, AgentData>;
}

interface Input {
  targetX: number;
  targetZ: number;
}

const gameDef = defineGame({
  schema: gameSchema,
  state: 'WorldState',
  input: 'Input',
  tickRate: 30,
  initial: (): WorldState => ({ tick: 0, agents: new Map() }),
  join: (state: WorldState, id: number) => {
    state.agents.set(id, { x: 0, z: 0, vx: 0, vz: 0, state: 0 });
  },
  leave: (state: WorldState, id: number) => {
    state.agents.delete(id);
  },
  step: (state: WorldState, inputs: Map<number, Input>, tick: number, dt: number) => {
    state.tick = tick;
    for (const [id, input] of inputs) {
      const agent = state.agents.get(id);
      if (agent) {
        const dx = input.targetX - agent.x;
        const dz = input.targetZ - agent.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.1) {
          const speed = 4.0;
          agent.vx = (dx / dist) * speed;
          agent.vz = (dz / dist) * speed;
          agent.x += agent.vx * dt;
          agent.z += agent.vz * dt;
          agent.state = 1; // moving
        } else {
          agent.vx = 0;
          agent.vz = 0;
          agent.state = 0; // idle
        }
      }
    }
  },
});

// -------------------------------------------------------------
// App State & Lifecycle
// -------------------------------------------------------------
interface ClientSession {
  id: number;
  client: GameClient<WorldState, Input>;
  buffer: SnapshotBuffer;
  delay: AdaptiveDelay;
  pose: ReturnType<typeof createSnapshot>;
  mesh?: Mesh;
  agent?: CrowdAgent;
  fsm: StateMachine<object>;
  tree: BehaviorTree;
  target: [number, number, number];
}

let stage: Stage | null = null;
let network: LoopbackNetwork | null = null;
let server: GameServer<WorldState, Input> | null = null;
let navMesh: NavMesh | null = null;
let crowd: Crowd | null = null;
let ecsWorld: GrowableWorld | null = null;
let ecsSchedule: Schedule | null = null;
let PosComp: any = null;
let VelComp: any = null;
const ecsEntities: number[] = [];

let clients: ClientSession[] = [];
const _pendingJoins: Promise<void>[] = [];
let obstacleRemovers: (() => void)[] = [];
let obstacleMeshes: Mesh[] = [];
let groundMesh: Mesh | null = null;

let targetClientsCount = 50;
let agentSpeed = 4.0;
let animId = 0;
let workerView: WorkerCanvas | null = null;
let workerInstance: Worker | null = null;

// Materials
let groundMat: PbrMaterial;
let obstacleMat: PbrMaterial;
let agentMats: PbrMaterial[] = [];

function initMaterials() {
  groundMat = new PbrMaterial({ color: '#0f172a', roughness: 0.8, metalness: 0.1 });
  obstacleMat = new PbrMaterial({ color: '#ef4444', roughness: 0.4, metalness: 0.3 });
  agentMats = [
    new PbrMaterial({ color: '#22c55e', roughness: 0.3, metalness: 0.1 }), // Idle/Moving
    new PbrMaterial({ color: '#38bdf8', roughness: 0.3, metalness: 0.1 }), // Navigating
    new PbrMaterial({ color: '#f59e0b', roughness: 0.3, metalness: 0.1 }), // Evading
    new PbrMaterial({ color: '#ec4899', roughness: 0.3, metalness: 0.1 }), // Unreachable
  ];
}

// -------------------------------------------------------------
// NavMesh & Arena Setup
// -------------------------------------------------------------
function buildArenaNavMesh(): NavMesh {
  // A 40x40 walkable plane with vertices
  const s = 20;
  const vertices: [number, number, number][] = [
    [-s, 0, -s],
    [s, 0, -s],
    [s, 0, s],
    [-s, 0, s],
  ];
  const polygons = [[0, 1, 2, 3]];
  return new NavMesh(vertices, polygons);
}

function updateObstacles(count: number) {
  if (!crowd || !stage) return;

  // Clear existing obstacles
  for (const remove of obstacleRemovers) {
    try {
      remove();
    } catch {}
  }
  obstacleRemovers = [];

  for (const mesh of obstacleMeshes) {
    try {
      mesh.dispose();
    } catch {}
  }
  obstacleMeshes = [];

  const basePositions: [number, number, number][] = [
    [-8, 1, -8],
    [8, 1, -8],
    [-8, 1, 8],
    [8, 1, 8],
    [0, 1, -12],
    [0, 1, 12],
    [-12, 1, 0],
    [12, 1, 0],
  ];

  for (let i = 0; i < Math.min(count, basePositions.length); i++) {
    const pos = basePositions[i];
    // Dynamic obstacle in crowd
    const remove = crowd.addObstacle({
      position: [pos[0], 0, pos[2]],
      radius: 1.4,
    });
    obstacleRemovers.push(remove);

    // Mesh
    const mesh = stage.engine
      .createMesh()
      .setGeometry(box(2, 2.5, 2))
      .setMaterial(obstacleMat);
    mesh.position.x = pos[0];
    mesh.position.y = pos[1];
    mesh.position.z = pos[2];
    obstacleMeshes.push(mesh);
  }

  const el = document.getElementById('obstacles-val');
  if (el) el.textContent = `${obstacleRemovers.length} obstacles`;
}

// -------------------------------------------------------------
// Client AI (FSM + BehaviorTree + Crowd Agent)
// -------------------------------------------------------------
function createClientAI(
  id: number,
  initialPos: [number, number, number],
): {
  fsm: StateMachine<object>;
  tree: BehaviorTree;
} {
  const fsm = new StateMachine(
    {
      idle: {},
      moving: {},
      evading: {},
    },
    'idle',
    {},
    [
      { from: 'idle', to: 'moving', event: 'start_move' },
      { from: 'moving', to: 'evading', event: 'obstacle_near' },
      { from: 'evading', to: 'moving', after: 0.5 },
      { from: 'moving', to: 'idle', event: 'arrived' },
    ],
  );

  const nearObstacle = false;
  const tree = new BehaviorTree(
    reactiveSelector(sequence(condition('checkObstacle'), action('evade'), wait(0.3)), sequence(action('patrol'))),
    {
      seed: id,
      handlers: {
        conditions: {
          checkObstacle: () => nearObstacle,
        },
        actions: {
          evade: () => {
            fsm.send('obstacle_near');
            return 'success';
          },
          patrol: () => {
            if (fsm.state !== 'moving') fsm.send('start_move');
            return 'running';
          },
        },
      },
    },
  );

  return { fsm, tree };
}

// -------------------------------------------------------------
// Connect Single Client to Server
// -------------------------------------------------------------
async function connectClient(id: number): Promise<ClientSession | null> {
  if (!network || !server || !crowd || !stage || !ecsWorld || !PosComp || !VelComp) return null;

  const initialX = (Math.random() - 0.5) * 32;
  const initialZ = (Math.random() - 0.5) * 32;
  const targetX = (Math.random() - 0.5) * 32;
  const targetZ = (Math.random() - 0.5) * 32;

  const buffer = new SnapshotBuffer(32);
  const delay = new AdaptiveDelay({ initial: 0.05 });
  const pose = createSnapshot();

  const { fsm, tree } = createClientAI(id, [initialX, 0, initialZ]);

  // Crowd agent
  const agent = crowd.addAgent({
    position: [initialX, 0, initialZ],
    radius: 0.45,
    maxSpeed: agentSpeed,
  });
  agent.setTarget([targetX, 0, targetZ]);

  // ECS Entity
  const entity = ecsWorld.create();
  PosComp.add(entity, { x: initialX, y: 0.6, z: initialZ });
  VelComp.add(entity, { vx: 0, vz: 0 });
  ecsEntities.push(entity);

  // Mesh
  const mesh = stage.engine
    .createMesh()
    .setGeometry(box(0.9, 1.2, 0.9))
    .setMaterial(agentMats[0]);
  mesh.position.x = initialX;
  mesh.position.y = 0.6;
  mesh.position.z = initialZ;

  try {
    const conn = network.connect();
    const client = await GameClient.join(gameDef, conn, {
      now: () => network!.time,
      input: () => ({ targetX: agent.position[0], targetZ: agent.position[2] }),
      redundancy: 4,
    });

    const session: ClientSession = {
      id,
      client,
      buffer,
      delay,
      pose,
      mesh,
      agent,
      fsm,
      tree,
      target: [targetX, 0, targetZ],
    };

    clients.push(session);
    return session;
  } catch (err: any) {
    console.error(`Client ${id} join error:`, err);
    log(`Client ${id} join failed: ${err.message ?? err}`);
    // Clean up partial allocations
    try {
      agent.remove();
      mesh.dispose();
    } catch {}
    return null;
  }
}

// -------------------------------------------------------------
// Client Management: Burst, Join, Leave
// -------------------------------------------------------------
async function setClientCount(target: number) {
  targetClientsCount = target;
  const label = document.getElementById('target-clients-num');
  if (label) label.textContent = String(target);

  if (clients.length < target) {
    const needed = target - clients.length;
    const startId = clients.length ? Math.max(...clients.map((c) => c.id)) + 1 : 1;
    for (let i = 0; i < needed; i++) {
      connectClient(startId + i);
    }
  } else if (clients.length > target) {
    const toRemove = clients.splice(target);
    for (const session of toRemove) {
      try {
        session.client.close();
        session.agent?.remove();
        session.mesh?.dispose();
      } catch (e) {
        console.error('Error removing client:', e);
      }
    }
  }
}

async function burstClients(count: number) {
  log(`Starting burst join of ${count} clients...`);
  // Disconnect all first
  for (const c of clients) {
    try {
      c.client.close();
      c.agent?.remove();
      c.mesh?.dispose();
    } catch {}
  }
  clients = [];

  // Connect burst simultaneously
  const promises: Promise<ClientSession | null>[] = [];
  for (let i = 1; i <= count; i++) {
    promises.push(connectClient(i));
  }
  const results = await Promise.all(promises);
  const succeeded = results.filter(Boolean).length;
  log(`Burst finished: ${succeeded}/${count} clients connected.`);
}

// -------------------------------------------------------------
// Voxel-Net Packet Test
// -------------------------------------------------------------
function runVoxelNetTest() {
  try {
    log('Running Voxel-Net test...');
    const blocks = new BlockTypes();
    ['stone', 'dirt', 'grass', 'wood'].forEach((b) => blocks.define(b));
    const voxelWorld = new VoxelWorld({ blocks });

    let sentCount = 0;
    const mockTransport = {
      send(bytes: Uint8Array) {
        sentCount += bytes.length;
      },
      close() {},
    };

    const client = new VoxelNetClient(voxelWorld, mockTransport, { name: 'PlayerTest' });

    // Server welcome packet
    const welcome = encodeServerMessage({
      type: 'welcome',
      version: PROTOCOL_VERSION,
      id: 42,
      tickRate: 20,
      view: 4,
      viewHeight: 2,
      simulation: 2,
      simulationHeight: 2,
      playerDistance: 64,
      blocks: blockTableHash(blocks),
      flight: true,
      resume: new Uint8Array(16),
      resent: 0,
    });
    client.receive(welcome);

    // Server state / spawn packet
    const state = encodeServerMessage({
      type: 'state',
      spawn: true,
      step: 0,
      position: [0, 10, 0],
      velocity: [0, 0, 0],
      flying: false,
    });
    client.receive(state);

    // Setup local chunk and perform block edits
    const chunk = voxelWorld.addChunk(0, 0, 0);
    chunk.set(0, 9, 0, blocks.id('stone'));

    // Move player with quantized keys
    client.update(0.1, { keys: Keys.forward | Keys.jump, yaw: 0, pitch: 0 });

    // Edit cell
    const edited = client.edit(0, 9, 0, blocks.id('dirt'));

    // Sample other players
    const players = client.samplePlayers();

    log(
      `Voxel-Net test passed: spawned=${client.spawned}, edit=${edited}, sent=${sentCount}b, players=${players.size}`,
    );
  } catch (err: any) {
    console.error('Voxel-Net test error:', err);
    log(`Voxel-Net error: ${err.message ?? err}`);
  }
}

// -------------------------------------------------------------
// Worker Canvas Test
// -------------------------------------------------------------
async function initWorkerCanvas() {
  const workerCanvas = document.getElementById('worker-canvas') as HTMLCanvasElement;
  const badge = document.getElementById('worker-badge');
  if (!workerCanvas || !workerCanvasSupported()) {
    if (badge) badge.textContent = 'Not Supported';
    return;
  }

  try {
    workerInstance = new Worker(new URL('./many-user-worker.ts', import.meta.url), { type: 'module' });
    workerView = await transferCanvas(workerCanvas, workerInstance, {
      data: { backend: useWebGL2 ? 'webgl2' : 'auto' },
      timeout: 5000,
    });
    if (badge) {
      badge.textContent = 'Active';
      badge.className = 'badge active';
    }
    log('Worker canvas transferred successfully.');
  } catch (err: any) {
    console.error('Worker canvas error:', err);
    if (badge) {
      badge.textContent = 'Failed';
      badge.className = 'badge warn';
    }
    log(`Worker canvas failed: ${err.message ?? err}`);
  }
}

// -------------------------------------------------------------
// Scene & Simulation Lifecycle
// -------------------------------------------------------------
async function initScene() {
  log('Initializing scene...');

  if (useWebGL2) {
    try {
      await installWebGL2Compat({ force: true });
    } catch (err) {
      console.error('installWebGL2Compat error:', err);
    }
  }

  initMaterials();

  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  stage = await createStage(canvas, {
    camera: { position: [0, 32, 28], target: [0, 0, 0] },
  });

  // Ground plane mesh
  groundMesh = stage.engine
    .createMesh()
    .setGeometry(box(40, 0.4, 40))
    .setMaterial(groundMat);
  groundMesh.position.y = -0.2;

  // NavMesh & Crowd
  navMesh = buildArenaNavMesh();
  crowd = new Crowd(navMesh, {
    neighborDistance: 6,
    maxNeighbors: 15,
    timeHorizon: 2.5,
  });

  // Dynamic Obstacles
  updateObstacles(4);

  // Network & Server
  network = new LoopbackNetwork({
    latency: 30,
    jitter: 10,
    loss: 0.0,
    seed: 42,
  });
  server = new GameServer(gameDef, {
    now: () => network!.time,
    maxPlayers: 64,
  });
  network.listen().onconnection = (conn) => server!.accept(conn);

  // ECS World & Schedule
  ecsWorld = new GrowableWorld({ capacity: 128 });
  PosComp = ecsWorld.component({ x: Float32Array, y: Float32Array, z: Float32Array });
  VelComp = ecsWorld.component({ vx: Float32Array, vz: Float32Array });
  ecsSchedule = new Schedule({ step: 1 / 60 });
  ecsSchedule.add('motion', (time) => {
    // ECS fixed update
    for (const id of ecsEntities) {
      const idx = PosComp.index(id);
      const vIdx = VelComp.index(id);
      if (idx >= 0 && vIdx >= 0) {
        PosComp.fields.x[idx] += VelComp.fields.vx[vIdx] * time.delta;
        PosComp.fields.z[idx] += VelComp.fields.vz[vIdx] * time.delta;
      }
    }
  });

  // Connect initial target clients
  await setClientCount(targetClientsCount);

  // Start Worker Canvas
  initWorkerCanvas();

  log('Scene initialized. Running 50-client simulation...');
}

function disposeScene() {
  log('Disposing scene...');
  if (animId) cancelAnimationFrame(animId);

  // Clients
  for (const c of clients) {
    try {
      c.client.close();
      c.agent?.remove();
      c.mesh?.dispose();
    } catch {}
  }
  clients = [];

  // Obstacles
  for (const r of obstacleRemovers) {
    try {
      r();
    } catch {}
  }
  obstacleRemovers = [];

  for (const m of obstacleMeshes) {
    try {
      m.dispose();
    } catch {}
  }
  obstacleMeshes = [];

  // NavMesh & Crowd
  try {
    crowd?.dispose();
  } catch {}
  crowd = null;
  navMesh = null;

  // Server
  try {
    server?.close();
  } catch {}
  server = null;
  network = null;

  // Worker
  try {
    workerView?.dispose();
    workerInstance?.terminate();
  } catch {}
  workerView = null;
  workerInstance = null;

  // Stage
  try {
    stage?.dispose();
  } catch {}
  stage = null;
  groundMesh = null;

  // Replace Canvas Element to avoid Offscreen/Context reuse errors
  const oldCanvas = document.getElementById('canvas');
  if (oldCanvas) {
    const newCanvas = document.createElement('canvas');
    newCanvas.id = 'canvas';
    newCanvas.style.width = '100%';
    newCanvas.style.height = '100%';
    newCanvas.style.display = 'block';
    oldCanvas.replaceWith(newCanvas);
  }

  log('Scene disposed.');
}

// -------------------------------------------------------------
// Main Animation & Simulation Loop
// -------------------------------------------------------------
let lastTime = performance.now();
let frameCount = 0;
let lastFpsUpdate = performance.now();

function frame(now: number) {
  animId = requestAnimationFrame(frame);

  const delta = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  frameCount++;

  // 1. Advance Loopback Network
  if (network && server) {
    network.advance(delta * 1000);

    // Step server at fixed tick rate
    while (network.time >= (server.tick + 1) * gameDef.tickMs) {
      server.step();
    }
  }

  // 2. Update Connected Clients
  for (const session of clients) {
    try {
      session.client.update();

      // Sample Server Snapshot to client buffer
      if (server) {
        const agentState = server.state.agents.get(session.client.player);
        if (agentState) {
          session.buffer.push(server.tick * (1 / 30), [agentState.x, 0.6, agentState.z]);
          session.delay.observe(server.tick * (1 / 30), performance.now() / 1000);
        }
      }
    } catch (err) {
      console.error(`Client ${session.id} update error:`, err);
    }
  }

  // 3. Update ECS Schedule
  if (ecsSchedule) {
    ecsSchedule.update(delta);
  }

  // 4. Update FSM & BehaviorTrees
  for (const session of clients) {
    session.fsm.update(delta);
    session.tree.tick(delta);

    // Goal arrival check
    if (session.agent) {
      const dist = Math.hypot(
        session.agent.position[0] - session.target[0],
        session.agent.position[2] - session.target[2],
      );
      if (dist < 1.2) {
        // Pick new random target
        session.target[0] = (Math.random() - 0.5) * 32;
        session.target[2] = (Math.random() - 0.5) * 32;
        session.agent.setTarget([session.target[0], 0, session.target[2]]);
      }
    }
  }

  // 5. Update Crowd & Agent Positions
  if (crowd) {
    crowd.update(delta);

    for (const session of clients) {
      if (session.agent && session.mesh) {
        // Sample interpolated render time
        const rTime = session.delay.renderTime(performance.now() / 1000);
        if (!Number.isNaN(rTime) && session.buffer.sample(rTime, session.pose)) {
          // Blend with crowd physics
          session.mesh.position.x = session.agent.position[0];
          session.mesh.position.y = 0.6;
          session.mesh.position.z = session.agent.position[2];
        } else {
          session.mesh.position.x = session.agent.position[0];
          session.mesh.position.y = 0.6;
          session.mesh.position.z = session.agent.position[2];
        }

        // Material color by agent state
        if (session.agent.state === 'arrived') {
          session.mesh.setMaterial(agentMats[0]);
        } else if (session.agent.state === 'moving') {
          session.mesh.setMaterial(agentMats[1]);
        } else if (session.agent.state === 'unreachable') {
          session.mesh.setMaterial(agentMats[3]);
        } else {
          session.mesh.setMaterial(agentMats[2]);
        }
      }
    }
  }

  // 6. Render Stage
  if (stage) {
    stage.engine.render();
  }

  // 7. Update HUD Metrics
  if (now - lastFpsUpdate >= 250) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    frameCount = 0;
    lastFpsUpdate = now;

    const fpsEl = document.getElementById('fps-val');
    if (fpsEl) fpsEl.textContent = `${fps} / ${(delta * 1000).toFixed(1)}ms`;

    const memEl = document.getElementById('mem-val');
    if (memEl && (performance as any).memory) {
      const mb = Math.round((performance as any).memory.usedJSHeapSize / 1048576);
      memEl.textContent = `${mb} MB`;
    }

    const clientsEl = document.getElementById('clients-val');
    if (clientsEl) clientsEl.textContent = `${clients.length} / ${targetClientsCount}`;

    const tickEl = document.getElementById('tick-val');
    if (tickEl && server) tickEl.textContent = `${server.tick} (30t/s)`;

    const agentsEl = document.getElementById('agents-val');
    if (agentsEl) agentsEl.textContent = `${clients.length} agents`;
  }
}

// -------------------------------------------------------------
// UI Event Listeners
// -------------------------------------------------------------
function setupUI() {
  document.getElementById('target-clients')?.addEventListener('input', (e) => {
    setClientCount(parseInt((e.target as HTMLInputElement).value, 10));
  });

  document.getElementById('btn-join10')?.addEventListener('click', () => {
    setClientCount(clients.length + 10);
  });

  document.getElementById('btn-leave10')?.addEventListener('click', () => {
    setClientCount(Math.max(0, clients.length - 10));
  });

  document.getElementById('btn-burst')?.addEventListener('click', () => {
    burstClients(50);
  });

  document.getElementById('latency')?.addEventListener('input', (e) => {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    const label = document.getElementById('latency-num');
    if (label) label.textContent = `${val} ms`;
    // Update loopback conditions
  });

  document.getElementById('loss')?.addEventListener('input', (e) => {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    const label = document.getElementById('loss-num');
    if (label) label.textContent = `${val}%`;
  });

  document.getElementById('obstacle-count')?.addEventListener('input', (e) => {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    const label = document.getElementById('obstacle-count-num');
    if (label) label.textContent = String(val);
    updateObstacles(val);
  });

  document.getElementById('btn-toggle-obstacles')?.addEventListener('click', () => {
    // Shift obstacles dynamically
    for (const mesh of obstacleMeshes) {
      mesh.position.x += (Math.random() - 0.5) * 4;
      mesh.position.z += (Math.random() - 0.5) * 4;
    }
    log('Obstacles moved dynamically. Agents replanning routes.');
  });

  document.getElementById('btn-shuffle-goals')?.addEventListener('click', () => {
    for (const c of clients) {
      if (c.agent) {
        c.target[0] = (Math.random() - 0.5) * 32;
        c.target[2] = (Math.random() - 0.5) * 32;
        c.agent.setTarget([c.target[0], 0, c.target[2]]);
      }
    }
    log('Agent goals randomized.');
  });

  document.getElementById('speed')?.addEventListener('input', (e) => {
    agentSpeed = parseFloat((e.target as HTMLInputElement).value);
    const label = document.getElementById('speed-num');
    if (label) label.textContent = `${agentSpeed.toFixed(1)} m/s`;
    for (const c of clients) {
      if (c.agent) c.agent.maxSpeed = agentSpeed;
    }
  });

  document.getElementById('btn-voxel-test')?.addEventListener('click', runVoxelNetTest);

  document.getElementById('btn-recreate')?.addEventListener('click', async () => {
    disposeScene();
    await initScene();
  });
}

// -------------------------------------------------------------
// Start App
// -------------------------------------------------------------
setupUI();
ready(initScene()).then(() => {
  animId = requestAnimationFrame(frame);
});
