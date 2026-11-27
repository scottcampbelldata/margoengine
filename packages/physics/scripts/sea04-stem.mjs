import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const base = new URL('../../../test-results/sea04-stem/', import.meta.url);
mkdirSync(base, { recursive: true });
const [command, grid] = process.argv.slice(2);
const dist = process.env.SEA04_STEM_SNAPSHOT ? new URL('built/', base) : new URL('../dist/', import.meta.url);
const [ { Physics }, { WakeSolver }, { HullSolver, volumeBelow }, { PhysicsWorld, RigidSolver, worldMemory } ] =
  command === 'predict' || command === 'source-control' ?
    await Promise.all(['index.js', 'sea.js', 'seakeeping.js', 'world.js'].map((name) => import(new URL(name,dist))))
    : [{},{},{},{}];
const path = (name) => new URL(`sea04-stem-${name}.json`, base);
const hash = (input) => createHash('sha256').update(input).digest('hex');
const read = (name) => JSON.parse(readFileSync(path(name), 'utf8'));
const write = (name, object) => writeFileSync(path(name), JSON.stringify(object, null, 2) + '\n');
const mean = (a) => a.reduce((sum, v) => sum + v, 0) / a.length;
const rms = (a) => Math.sqrt(mean(a.map((v) => v * v)));
const plan = {
  facility: 'Kajitani et al. (1983), fixed University of Tokyo model, section 1 and Table I.',
  length_m: 2.5,
  beam_m: 0.25,
  draft_m: 0.156,
  finalDepthBandMargin_m: 0.0005,
  physicalTankWidth_m: 3.5,
  depth_m: 2.35,
  g_mps2: 9.8,
  density_kgm3: 1000,
  froude: [0.267, 0.316],
  stations_2xOverL: [-1, -0.95, -0.90, -0.85, -0.80, -0.75, -0.70, -0.65, -0.60],
  physicalTravelLengths: [1.5, 2, 2.5],
  selectedTravelLength: 2.5,
  startX_m: -4,
  gridSize_m: [12, 4],
  spongeThickness_m: 0.5,
  rate_hz: 60,
  meshStations: 48,
  meshDepthLevels: 24,
  gauges: 'Exact still-water beam contour at each Table I coordinate. Port/starboard average.',
  waterlineCondition: 'The hull is fixed in trim and sinkage and free only to travel at the prescribed speed along +X.',
  geometryScope: 'Fixed absorbing grid. The 3.5 m reflective tank width, wall run-up and wet moving hull are outside this wake-grid model.',
  grids: { coarse: 0.05, fine: 0.025 },
  variants: ['surfaceAdvance', 'depthBanded'],
  comparisonScope: 'The stem and the nine contiguous bow stations. Freeze bundle, plan and packet hashes before reading elevations.',
};
const planSha = hash(JSON.stringify(plan));
const bundleHashes = () =>
  Object.fromEntries(['index.js', 'world.js', 'sea.js', 'seakeeping.js'].map((name) =>
    [name, hash(readFileSync(new URL(name, dist)))]
  ));
const heldout = new URL('sea04-stem-observations.json', import.meta.url);

function meshWigley() {
  const { length_m: length, beam_m: beam, draft_m: draft, meshStations: stations, meshDepthLevels: levels } = plan;
  const side = Array.from({ length: levels }, (_, j) => {
    const y = (-draft * (levels - j - 1)) / levels;
    return [y, 1 - (y / draft) ** 2];
  });
  // Surface-piercing parabolic hull with a dry vertical closure. The dry closure adds no displacement.
  const section = [[-draft, 0], ...side, [0.1, 1], [0.1, -1], ...side.map(([y,z]) => [y, -z]).reverse()];
  const stride = section.length;
  const vertices = new Float64Array(3 * (stations + 1) * stride);
  const indices = [];
  for (let i = 0; i <= stations; i++) {
    const x = length * (i / stations - 0.5);
    const width = (beam / 2) * (1 - ((2 * x) / length) ** 2);
    for (let j = 0; j < stride; j++) {
      const [y, f] = section[j];
      const a = i * stride + j;
      vertices.set([x, y, width * f], 3 * a);
      if (i === stations) continue;
      const b = a + stride;
      const d = i * stride + ((j + 1) % stride);
      indices.push(a, b, d + stride, a, d + stride, d);
    }
  }
  return { vertices, indices: Uint32Array.from(indices) };
}

function readWaterline(wake, origin, speed) {
  return plan.stations_2xOverL.map((station) => {
    const x = (-station * plan.length_m) / 2;
    const halfBeam = (plan.beam_m / 2) * (1 - station ** 2);
    const dbdx = (-4 * plan.beam_m * x) / plan.length_m ** 2;
    const starboard = wake.sample(origin + x, halfBeam);
    const port = wake.sample(origin + x, -halfBeam);
    // Surface-linearized Neumann diagnostic. The side facing +Z has
    // outward normal (-db/dx,0,1). Use the mirrored side at -Z.
    const scale = Math.hypot(dbdx, 1);
    const required = (-dbdx * speed) / scale;
    const induced = (-dbdx * (starboard.velocity[0] + port.velocity[0])
      + starboard.velocity[2] - port.velocity[2]) / (2 * scale);
    return {
      station_2xOverL: station,
      bodyX_m: x,
      halfBeam_m: halfBeam,
      height_m: (starboard.height + port.height) / 2,
      lateral_symmetry_delta_m: starboard.height - port.height,
      prescribed_side_normal_mps: required,
      predicted_side_normal_mps: induced,
      side_normal_residual_mps: induced - required,
    };
  });
}

function predict(grid, froude, variant, stations = 24) {
  const mesh = meshWigley();
  const g = plan.g_mps2;
  const density = plan.density_kgm3;
  const speed = froude * Math.sqrt(g * plan.length_m);
  const dt = 1 / plan.rate_hz;
  const world = new PhysicsWorld({ rate: { num: plan.rate_hz, den: 1 }, gravity: [0,-g,0], memory: worldMemory(false) });
  using physics = new Physics(null, { arena: world.arena, gravity: [0,-g,0], fixedTimestep: dt, substeps: 1 });
  const volume = volumeBelow(mesh, [0,1,0], 0);
  assert.ok(Math.abs(volume / ((4 / 9) * plan.length_m * plan.beam_m * plan.draft_m) - 1) < 0.002);
  const body = physics.addBody(null, {
    position: [plan.startX_m,0,0],
    linearVelocity: [speed,0,0],
    enabledTranslations: [true,false,false],
    enabledRotations: [false,false,false],
    colliders: { shape: 'box', halfExtents: [plan.length_m/2,plan.draft_m,plan.beam_m/2], mass: density * volume },
  });
  const cellSize = plan.grids[grid];
  const depthEdges = Array.from({ length: 5 }, (_, i) => plan.draft_m * i / 4);
  // Cover half the source's printed draft increment for the mass-derived
  // reference surface. The actual mesh and target draft stay untouched.
  depthEdges[4] += plan.finalDepthBandMargin_m;
  const wakeOptions = variant === 'depthBanded'
    ? { minimumRadius: cellSize / Math.sqrt(2), submergedAdvance: depthEdges }
    : { minimumRadius: cellSize / Math.sqrt(2), advance: true };
  const hull = new HullSolver('hull', wakeOptions);
  const wave = new WakeSolver('wake', hull.wakeSourceField, hull.submergedWakeSource);
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: body.row, mesh }],
      stations,
      sea: { density, elevation: () => 0 },
      addedMass: false,
      drag: false,
      diffraction: false,
      drift: false,
      greenWater: false,
      radiation: false,
      rollDamping: false,
      slamming: false,
    })
    .add(wave, {
      cells: plan.gridSize_m.map((width) => Math.round(width / cellSize)),
      cellSize,
      depth: plan.depth_m,
      sponge: Math.round(plan.spongeThickness_m / cellSize),
      density,
    })
    .couple(['hull', 'wake', 'rigid'], 'staggered');
  const history = [];
  for (const distance of plan.physicalTravelLengths) {
    const tick = Math.round((distance * plan.length_m) / (speed * dt));
    world.advance(tick);
    const [origin, heave, sway] = body.position;
    assert.ok(Math.abs(origin - (plan.startX_m + tick * dt * speed)) < 5e-4);
    assert.equal(heave, 0);
    assert.equal(sway, 0);
    const rows = readWaterline(wave, origin, speed);
    assert.ok(rows.every((value) => Object.values(value).every(Number.isFinite)));
    history.push({ targetTravelLengths: distance, tick, origin_m: origin, actualTravel_m: origin-plan.startX_m, stations: rows });
  }
  assert.ok(history.at(-1).stations.some((row) => Math.abs(row.height_m)>0.005));
  return { grid, spec: wakeOptions, sourceStations: stations, froude, variant, speed_mps: speed, volume_m3: volume, history };
}

if (command === 'predict') {
  assert.ok(grid in plan.grids);
  await Physics.load();
  const fingerprints = bundleHashes();
  console.log('frozen plan', planSha, grid);
  const forecasts = [];
  for (const variant of plan.variants) {
    for (const froude of plan.froude) {
      const result = predict(grid, froude, variant);
      forecasts.push(result);
      console.log('forecast', grid, variant, froude, result.history.at(-1).stations[0].height_m);
    }
  }
  assert.deepEqual(bundleHashes(), fingerprints, 'Physics bundles changed during this comparison.');
  write(`prediction-${grid}`, { plan, planSha, grid, bundleHashes: fingerprints, forecasts });
} else if (command === 'source-control') {
  // Fix the source strip width to the fine wake cell width before scoring.
  // This is a geometric convergence control using the same submerged hull.
  await Physics.load();
  const fingerprints = bundleHashes();
  const sourceStations = Math.ceil(plan.length_m / plan.grids.fine);
  const result = predict('fine', 0.267, 'surfaceAdvance', sourceStations);
  assert.deepEqual(bundleHashes(), fingerprints, 'Physics bundles changed during the source control.');
  write('source-control', { planSha, bundleHashes: fingerprints, result });
  console.log('independent source-refinement forecast', sourceStations, result.history.at(-1).stations[0].height_m);
} else if (command === 'freeze') {
  const keys = Object.keys(plan.grids).map((key) => `prediction-${key}`);
  const fingerprints = keys.map((key) => {
    const data = read(key);
    assert.equal(data.planSha, planSha);
    return data.bundleHashes;
  });
  assert.deepEqual(fingerprints[0], fingerprints[1], 'Compare only grids run with identical Physics bundles.');
  let sourceControlSha;
  if (existsSync(path('source-control'))) {
    const control = read('source-control');
    assert.equal(control.planSha, planSha);
    assert.deepEqual(control.bundleHashes, fingerprints[0], 'Run the source control against the same Physics bundles.');
    sourceControlSha = hash(readFileSync(path('source-control')));
  }
  write('freeze', {
    planSha,
    sourceControlSha,
    bundleHashes: fingerprints[0],
    predictedSha: Object.fromEntries(keys.map((key) => [key, hash(readFileSync(path(key)))])),
    sourceTranscriptionSha: hash(readFileSync(heldout)),
  });
} else if (command === 'score') {
  const frozen = read('freeze');
  const sourceData = readFileSync(heldout);
  assert.equal(frozen.planSha, planSha);
  assert.equal(hash(sourceData), frozen.sourceTranscriptionSha);
  for (const [name, digest] of Object.entries(frozen.predictedSha)) assert.equal(hash(readFileSync(path(name))), digest);
  const data = JSON.parse(sourceData);
  assert.deepEqual(data.froude_by_column, plan.froude);
  assert.deepEqual(data.rows.map(([station]) => station), plan.stations_2xOverL);
  const scores = Object.keys(frozen.predictedSha).flatMap((name) => read(name).forecasts.map((result) => {
    const scale = result.speed_mps ** 2 / plan.g_mps2;
    const index = 1 + plan.froude.indexOf(result.froude);
    const observation = data.rows.map((measured) => scale * measured[index]);
    const latest = result.history.find((snapshot) => snapshot.targetTravelLengths === plan.selectedTravelLength);
    const middle = result.history.find((snapshot) => snapshot.targetTravelLengths === 2);
    const stations = latest.stations.map((row,i) => ({
      ...row, observed_m: observation[i], error_m: row.height_m-observation[i],
    }));
    const peak = stations.reduce((max,row) => row.height_m>max.height_m ? row : max);
    return {
      ...result, stations, sternExcluded: true,
      stemError_m: stations[0].error_m,
      observedStem_m: observation[0],
      predictedStem_m: stations[0].height_m,
      maximumPredicted_m: peak.height_m,
      maximumPredicted_2xOverL: peak.station_2xOverL,
      maximumObserved_m: Math.max(...observation),
      maximumObserved_2xOverL: stations[observation.indexOf(Math.max(...observation))].station_2xOverL,
      bowProfileRms_m: rms(stations.map((row) => row.error_m)),
      profileChangeBetween2and2_5Lengths_m: rms(stations.map((row,i) => row.height_m-middle.stations[i].height_m)),
      sideNormalRms_mps: rms(stations.slice(1).map((row) => row.side_normal_residual_mps)),
      printedHalfIncrement_m: 0.5 * data.printed_ordinate_step * scale,
    };
  }));
  const twoGrid = scores.filter((s) => s.grid==='fine').map((fine) => {
    const coarse = scores.find((s) => s.grid==='coarse' && s.froude===fine.froude && s.variant===fine.variant);
    return { froude: fine.froude, variant: fine.variant, sameStationDeltaRms_m: rms(fine.stations.map((row,i) =>
      row.height_m-coarse.stations[i].height_m)),
      stemDelta_m: fine.predictedStem_m-coarse.predictedStem_m };
  });
  let sourceControl;
  if (frozen.sourceControlSha) {
    assert.equal(hash(readFileSync(path('source-control'))), frozen.sourceControlSha);
    const control = read('source-control').result;
    const baseline = scores.find((run) => run.grid==='fine' && run.froude===control.froude && run.variant===control.variant);
    const stations = control.history.find((run) => run.targetTravelLengths===plan.selectedTravelLength).stations;
    sourceControl = {
      stations: control.sourceStations,
      baselineStations: baseline.sourceStations,
      sameStationDeltaRms_m: rms(stations.map((row,i) => row.height_m-baseline.stations[i].height_m)),
      observedStem_m: baseline.observedStem_m,
      predictedStem_m: stations[0].height_m,
      sideNormalRms_mps: rms(stations.slice(1).map((row) => row.side_normal_residual_mps)),
    };
  }
  write('score', { source: data.reference, sourcePdfSha: data.source_pdf_sha256, planSha, sourceControl,
    scoreQualification: 'Measured diagnostic. Report source printing, travel sensitivity, grid changes and model residual separately. The source does not report WG uncertainty.',
    twoGrid, scores });
  for (const s of scores) {
    console.log(s.grid,s.variant,s.froude, 'stem predicted/observed mm', 1000*s.predictedStem_m, 1000*s.observedStem_m,
      'profile RMS mm', 1000*s.bowProfileRms_m, 'normal RMS m/s', s.sideNormalRms_mps);
  }
  console.log('two-grid', JSON.stringify(twoGrid));
  if (sourceControl) console.log('source refinement', JSON.stringify(sourceControl));
} else {
  throw new Error('Run predict coarse, predict fine, source-control, freeze or score.');
}
