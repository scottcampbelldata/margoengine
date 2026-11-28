import { EngineKernel } from '/packages/core/dist/index.js';
import { BlownSand } from '/packages/vfx/dist/blown-sand.js';
import { AeolianTransport } from '/packages/physics/dist/aeolian.js';
import { BoundaryLayerSolver } from '/packages/physics/dist/boundary-layer.js';
import { TerrainBed } from '/packages/physics/dist/earth.js';
import { PhysicsWorld, regionWords } from '/packages/physics/dist/world.js';
import { FilmClock } from '/packages/math/dist/clock.js';
import { BoundaryLayerWind } from '/packages/weather/dist/boundary-layer.js';
import { travellingGust } from '/packages/weather/dist/turbulence.js';
import { planeGeometry } from '/packages/geometry/dist/index.js';
import { LambertMaterial, createMesh } from '/packages/materials/dist/index.js';
import { Font, Text, TextRenderer } from '/packages/text/dist/index.js';
import { Tonemap } from '/packages/tonemap/dist/index.js';
import { waitForPipelines } from '/scripts/support/gpu-ready.js';

// TREE-5 technical crest at real scale. Snow transport and redistribution follow the live bed and air.
// Ridge and lee placement reference: Mott et al. (2010), https://doi.org/10.5194/tc-4-545-2010.
export async function snowRidge(canvas, errors) {
  const grid = { columns: 24, rows: 32, width: 24, depth: 32, centre: [0, 3] };
  const nx = grid.columns + 1;
  const nz = grid.rows + 1;
  const x0 = -12;
  const z0 = -13;
  const crest = (x, z) => Math.max(0, 1.95 - (z < 0 ? 0.22 : 0.38) * Math.abs(z)) + 0.18 * Math.cos(x * 0.34);
  const loose = (x, z) => (z >= -3 && z <= 0 && Math.abs(x) <= 8 ? 0.055 : 0);
  const rock = (x, z) => crest(x, z) - loose(x, z);
  const mobileDepth = Float64Array.from({ length: nx * nz }, (_, i) => loose(x0 + (i % nx), z0 + Math.floor(i / nx)));
  const bulkDensity = 120;
  const referenceHeight = 2;
  const roughness = 0.001;
  const gust = { origin: [0, 0, -6], start: 0.35, direction: Math.PI / 2, speed: 8, length: 40, amplitude: [0, 0, 13] };
  const atmosphere = await BoundaryLayerSolver.load({ id: 'ridge-air' });
  const transport = await AeolianTransport.load();
  const terrain = new TerrainBed();
  const film = new FilmClock({ fps: 60 });
  const world = new PhysicsWorld({ rate: film.fps });
  world.add(atmosphere, {
    profile: new BoundaryLayerWind({ speed: 0, turbulence: false, ground: -1, roughness }).profile,
    grid: { cells: [2, 3, 4], origin: [-12, 0, -13], spacing: [24, 1, 9] },
  });
  const wind = travellingGust(atmosphere, gust);
  world.add(terrain, { ...grid, elevations: crest, bedrock: rock });
  world.add(transport, {
    grid,
    material: 'snow',
    wind,
    referenceHeight,
    roughness,
    bulkDensity,
    mobileDepth,
    settlingTime: 0.27,
  });

  canvas.style.cssText = 'display:block;width:640px;height:360px';
  // Exact-size technical captures use single-sample coverage, so the blended field does not inherit
  // per-backend multisample edge resolution from the old sand view.
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [640, 360],
    antialias: false,
    camera: { position: [-14.5, 4.2, -1.8], target: [0, 1.3, 2.7], fov: 42, near: 0.12, far: 78 },
  });
  engine.scene.background = '#51677f';
  engine.lighting.direction.set([-0.47, 0.68, -0.56, 1.35]);
  engine.lighting.radiance.set([0.92, 0.95, 1, 0.95]);
  engine.lighting.ambient.set([0.68, 0.77, 0.92]);
  Tonemap.attach(engine);

  const bed = terrain.bed;
  const geometry = planeGeometry(grid.width, grid.depth, grid.columns, grid.rows);
  const colors = new Float32Array(4 * nx * nz);
  geometry.colors = colors;
  for (let i = 0; i < geometry.positions.length; i += 3) {
    geometry.positions[i + 2] = 3 - geometry.positions[i + 1];
  }
  const bare = [0.115, 0.161, 0.209];
  const powder = [0.75, 0.82, 0.89];
  const grain = 0.0002;
  function updateGeometry() {
    for (let i = 0; i < geometry.positions.length; i += 3) {
      const x = geometry.positions[i];
      const z = geometry.positions[i + 2];
      const { elevation, normal } = bed.sample(x, z);
      const thickness = Math.max(0, elevation - rock(x, z));
      // Patch coverage grows across a few exposed layers of powder. Colours are linear surface albedos.
      const covered = 1 - Math.exp(-thickness / (3 * grain));
      geometry.positions[i + 1] = elevation;
      geometry.normals.set(normal, i);
      colors.set([...bare.map((channel, k) => channel + covered * (powder[k] - channel)), 1], (4 * i) / 3);
    }
  }
  updateGeometry();
  const mesh = createMesh(engine, geometry, new LambertMaterial({ vertexColors: true }));
  const glyphs = TextRenderer.attach(engine);
  const bodyFont = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const heading = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const caption = (text, position, font, fontSize, color) =>
    glyphs.add(new Text({ text, position, font, fontSize, color, billboard: true, onTop: true }));
  caption('Snow over the ridge', [-3, 5.3, -4.56], heading, 0.54, '#edf1f6');
  caption('Wind strips the crest and leaves snow in its lee', [-3, 4.64, -4.52], bodyFont, 0.29, '#d6e0ea');

  const ctx = engine.gpu;
  ctx.pushErrorScope('validation');
  ctx.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  engine.onError = (error) => errors.push(String(error));
  let sampled = 0;
  let motion;
  function acceptedMotion() {
    const port = world.fields.port(transport.motionField.name);
    if (!port || port.region.layout !== 1 || port.region.type !== 'f64')
      throw new Error('The ridge requires the layout-1 mass and velocity port.');
    return regionWords(world.memory, port.region);
  }
  motion = acceptedMotion();
  const source = {
    get bounds() {
      return transport.bounds;
    },
    get revision() {
      return transport.revision;
    },
    sample(x, z) {
      const sample = transport.sample(x, z);
      if (sample) {
        const offset = 3 * (Math.round(x - x0) + nx * Math.round(z - z0));
        if (sample.mass !== motion[offset] || sample.velocity.some((value, i) => value !== motion[offset + i + 1]))
          throw new Error('The renderer must use the accepted saltation mass and velocity.');
        sampled++;
      }
      return sample;
    },
  };
  const snow = BlownSand.attach(engine, {
    ground: (x, z) => bed.sample(x, z).elevation,
    transport: source,
    color: '#e1ebf6',
    height: 0.25,
    streak: 0.29,
    seed: 7,
    range: 32,
  });
  const draw = async () => {
    engine.render({ delta: 0 });
    await ctx.queue.onSubmittedWorkDone();
  };
  await waitForPipelines(draw);

  const cue = 12;
  const duration = 540;
  const initial = world.takeSnapshot();
  const checkpoints = new Map();
  let acceptedFrame = 0;
  let recorded;
  const referenceMass = transport.budget.mobileBed;
  const baselineVolume = terrain.volume();
  function observe() {
    let moving = 0;
    let moment = 0;
    for (let z = 1; z < nz - 1; z++) {
      for (let x = 1; x < nx - 1; x++) {
        // Interior control volumes are 1 m². The closed boundary is outside the active plume.
        const local = motion[3 * (x + nx * z)];
        moving += local;
        moment += local * (z0 + z);
      }
    }
    const crown = bed.sample(0, 0).elevation;
    const lee = bed.sample(0, 1).elevation;
    const air = wind.sample(0, crown + referenceHeight, 0, world.time).velocity;
    return {
      crown,
      lee,
      air,
      crest: transport.sample(0, 0),
      leeSaltation: transport.sample(0, 1),
      bedVolume: terrain.volume() - baselineVolume,
      ledger: transport.budget,
      areaMass: moving,
      saltationCenter: moving > 0 ? moment / moving : null,
    };
  }
  window.snowClose = async () => {
    snow.dispose();
    glyphs.dispose();
    mesh.destroy();
    const validation = (await ctx.popErrorScope())?.message ?? null;
    engine.dispose();
    return validation;
  };
  return async ({ frame, draw: visible, action }) => {
    film.frame = frame;
    const goal = Math.max(0, Math.min(duration, film.frame - cue));
    if (action === 'restore') {
      world.restoreSnapshot(recorded.snapshot.bytes);
      acceptedFrame = recorded.frame;
    } else if (goal < acceptedFrame) {
      world.restoreSnapshot(initial.bytes);
    }
    world.advance(goal);
    acceptedFrame = goal;
    const snapshot = world.takeSnapshot();
    const last = checkpoints.get(goal);
    if (!last) checkpoints.set(goal, snapshot.bytes);
    else if (snapshot.bytes.length !== last.length || snapshot.bytes.some((value, i) => value !== last[i]))
      throw new Error('Accepted terrain, air and saltation snapshots must restore byte for byte.');
    if (action === 'save') recorded = { snapshot, frame: goal };
    motion = acceptedMotion();
    updateGeometry();
    mesh.setGeometry(geometry);
    // A terrain-only pass starts every independently directed frame from the same target contents.
    snow.options.amount = 0;
    snow.time = world.time;
    await draw();
    const before = sampled;
    const bareDraws = engine.stats.drawCalls;
    if (visible) {
      snow.options.amount = 1;
      await draw();
      // Capture from the same populated instance layout even on the first submission after a seek.
      await draw();
    }
    return {
      hash: snapshot.hash,
      time: world.time,
      particles: visible ? snow.stats.particles : 0,
      snowDraws: engine.stats.drawCalls - bareDraws,
      readAccepted: sampled > before,
      initialMass: referenceMass,
      cue,
      duration,
      gust,
      bulkDensity,
      ...observe(),
      errors: errors.splice(0),
    };
  };
}
