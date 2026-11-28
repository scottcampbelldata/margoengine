// Run against the built Physics package from the repository root:
// node scripts/run-with-timeout.mjs --max=1 -- node packages/physics/scripts/life05-pedestrian-measured.mjs
//
// A. Seyfried, B. Steffen, W. Klingsch & M. Boltes (2005), "The fundamental diagram
// of pedestrian movement revisited", J. Stat. Mech. P10002, Fig. 2 and Table 1.
// https://doi.org/10.1088/1742-5468/2005/10/P10002
// The experiment supplied population, loop length and passage dimensions. The
// manual video measurements were holdouts. Only the reported cohort summary facts for
// ordinary non-passing walking are retained here, with no copied trajectory files.

import assert from 'node:assert/strict';
import { PedestrianCrowd } from '../dist/pedestrians.js';
import { PhysicsWorld } from '../dist/world.js';

const LOOP_METRES = 17.3;
const STRAIGHT_METRES = 4;
const HALF_STRAIGHT = STRAIGHT_METRES / 2;
const STRAIGHT_WIDTH = 0.8;
const BEND_WIDTH = 1.2;
const HALF_SEPARATION = (2.9 + STRAIGHT_WIDTH) / 2; // Figure 2's 2.9 m is between inner walls.
const STATION_METRES = 2;
const PRESET_SPEED = 1.34;
const LOOKAHEAD = PRESET_SPEED * 0.5; // Production default velocity-recovery time, in seconds.
const FPS = 60;
const WARMUP = 20;
const DURATION = 100;
const MEASURED = [
  { people: 1, speed: [1.24, 0.15], automaticSpeed: [1.37, 0.21] },
  { people: 15, speed: [0.9, 0.05], automaticSpeed: [0.88, 0.15], localDensity: [0.77, 0.12] },
  { people: 20, speed: [0.56, 0.05], automaticSpeed: [0.51, 0.11], localDensity: [1.07, 0.11] },
];

function makeBend(runout, shape, segments) {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const theta = (Math.PI * i) / segments;
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    return {
      point: [HALF_STRAIGHT + runout * sin * (1 + shape * cos * cos), -HALF_SEPARATION * cos],
      tangent: [runout * cos * (1 + shape * (cos * cos - 2 * sin * sin)), HALF_SEPARATION * sin],
      halfWidth: (STRAIGHT_WIDTH + (BEND_WIDTH - STRAIGHT_WIDTH) * sin * sin) / 2,
    };
  });
}

function track(shape, segments) {
  // The diagram gives widths and extremal dimensions but no curve equation.
  // Solve the bend runout using the measured loop length and two 4 m straights.
  let low = 0;
  let high = HALF_SEPARATION;
  for (let i = 0; i < 44; i++) {
    const radius = (low + high) / 2;
    const right = makeBend(radius, shape, segments);
    const length = right.slice(1).reduce((sum, { point }, row) => {
      const previous = right[row].point;
      return sum + Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    }, 0);
    if (2 * (STRAIGHT_METRES + length) < LOOP_METRES) low = radius;
    else high = radius;
  }
  const right = makeBend((low + high) / 2, shape, segments);
  const loop = right.concat(
    right.map(({ point, tangent, halfWidth }) => ({
      point: [-point[0], -point[1]],
      tangent: [-tangent[0], -tangent[1]],
      halfWidth,
    })),
  );
  const chains = [-1, 1].map((sign) =>
    loop.map(({ point, tangent, halfWidth }) => {
      const width = (sign * halfWidth) / Math.hypot(...tangent);
      return [point[0] - tangent[1] * width, point[1] + tangent[0] * width];
    }),
  );
  const walls = chains.flatMap((chain) => chain.map((point, i) => [point, chain[(i + 1) % chain.length]]));
  let length = 0;
  const lines = loop.map(({ point: [x, z] }, i) => {
    const [x2, z2] = loop[(i + 1) % loop.length].point;
    const span = Math.hypot(x2 - x, z2 - z);
    const line = { x, z, ax: (x2 - x) / span, az: (z2 - z) / span, span, start: length };
    length += span;
    return line;
  });
  assert.ok(Math.abs(length - LOOP_METRES) < 1e-10);

  function nearest(x, z) {
    let smallest = Infinity;
    let station = 0;
    for (const line of lines) {
      const dx = x - line.x;
      const dz = z - line.z;
      const along = Math.max(0, Math.min(line.span, dx * line.ax + dz * line.az));
      const squared = (dx - along * line.ax) ** 2 + (dz - along * line.az) ** 2;
      if (squared < smallest) {
        smallest = squared;
        station = line.start + along;
      }
    }
    return station;
  }

  function position(distance) {
    const station = distance % length;
    const line = lines.find((edge) => station < edge.start + edge.span);
    const along = station - line.start;
    return [line.x + along * line.ax, 0, line.z + along * line.az];
  }
  return { length, nearest, position, walls };
}

function gate(previous, next, x) {
  if (!(previous[0] < x && next[0] >= x)) return undefined;
  const t = (x - previous[0]) / (next[0] - previous[0]);
  const z = previous[2] + t * (next[2] - previous[2]);
  return Math.abs(z + HALF_SEPARATION) <= STRAIGHT_WIDTH / 2 ? t : undefined;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function run(people, bendShape, segments) {
  const lane = track(bendShape, segments);
  const crowd = await PedestrianCrowd.load();
  const bodies = Array.from({ length: people }, (_, i) => ({
    position: lane.position((i * lane.length) / people),
  }));
  const world = new PhysicsWorld({ rate: { num: FPS, den: 1 } }).add(crowd, { bodies, walls: lane.walls });
  let previous = bodies.map(({ position }) => position);
  const lastEntry = new Float64Array(people).fill(-Infinity);
  const traversals = [];
  let stationOccupancy = 0;
  for (let frame = 1; frame <= DURATION * FPS; frame++) {
    // This route command uses only the published geometry. Native contact,
    // force response, avoidance and integration decide the actual speeds.
    for (const [row, [x, , z]] of previous.entries()) {
      const [aimX, , aimZ] = lane.position(lane.nearest(x, z) + LOOKAHEAD);
      const dx = aimX - x;
      const dz = aimZ - z;
      const distance = Math.hypot(dx, dz);
      crowd.setPreferredVelocity(row, [(PRESET_SPEED * dx) / distance, (PRESET_SPEED * dz) / distance]);
    }
    world.advance(frame);
    const positions = previous.map((_, row) => crowd.read(row).position);
    for (const [row, point] of positions.entries()) {
      const incoming = gate(previous[row], point, -STATION_METRES / 2);
      if (incoming !== undefined) lastEntry[row] = (frame - 1 + incoming) / FPS;
      const outgoing = gate(previous[row], point, STATION_METRES / 2);
      if (outgoing !== undefined && lastEntry[row] >= WARMUP) {
        const end = (frame - 1 + outgoing) / FPS;
        traversals.push({ row, start: lastEntry[row], end, duration: end - lastEntry[row] });
        lastEntry[row] = -Infinity;
      }
      if (
        frame > WARMUP * FPS &&
        Math.abs(point[0]) < STATION_METRES / 2 &&
        Math.abs(point[2] + HALF_SEPARATION) <= STRAIGHT_WIDTH / 2
      ) {
        stationOccupancy++;
      }
    }
    previous = positions;
  }

  assert.ok(traversals.length >= 2, 'The fixed live run must deliver station crossings.');
  const velocities = traversals.map(({ duration }) => STATION_METRES / duration);
  const average = mean(velocities);
  const first = traversals.filter(({ end }) => end < (DURATION + WARMUP) / 2);
  const last = traversals.filter(({ start }) => start >= (DURATION + WARMUP) / 2);
  const entryOrder = traversals.slice().sort((a, b) => a.start - b.start);
  return {
    crossings: traversals.length,
    meanSpeedMetresPerSecond: average,
    sampleSDMetresPerSecond: Math.sqrt(
      velocities.reduce((sum, v) => sum + (v - average) ** 2, 0) / (velocities.length - 1),
    ),
    firstHalfSpeedMetresPerSecond: first.length ? mean(first.map(({ duration }) => STATION_METRES / duration)) : null,
    secondHalfSpeedMetresPerSecond: last.length ? mean(last.map(({ duration }) => STATION_METRES / duration)) : null,
    // Time-averaged count/length. Section 3.3 says this and their fractional
    // density have nearly the same averages. There is no comparison of fluctuations.
    countBasedStationDensityPerMetre: stationOccupancy / ((DURATION - WARMUP) * FPS * STATION_METRES),
    completedStationOrderDisagreements: entryOrder.reduce(
      (sum, crossing, i) => sum + Number(crossing !== traversals[i]),
      0,
    ),
  };
}

for (const measured of MEASURED) {
  const reference = await run(measured.people, 0, 24);
  const fine = await run(measured.people, 0, 48);
  const alternative = await run(measured.people, 0.3, 48);
  const [measuredSpeed, observedSD] = measured.speed;
  const duration = STATION_METRES / measuredSpeed;
  // Each manually read crossing time has 0.04 s resolution. Bound a nominal
  // traversal by two frames total, separately from experimental participant SD.
  const clockBound = [STATION_METRES / (duration + 0.08), STATION_METRES / (duration - 0.08)];
  console.log(
    JSON.stringify({
      people: measured.people,
      nominalLineDensityPerMetre: measured.people / LOOP_METRES,
      meanInitialSpacingMetres: LOOP_METRES / measured.people,
      measuredManualMeanMetresPerSecond: measuredSpeed,
      measuredManualSDMetresPerSecond: observedSD,
      manualNominalClockBoundMetresPerSecond: clockBound,
      measuredAutomaticMeanAndSDMetresPerSecond: measured.automaticSpeed,
      measuredManualStationDensityMeanAndSDPerMetre: measured.localDensity ?? null,
      fine,
      solverMinusManualMetresPerSecond: fine.meanSpeedMetresPerSecond - measuredSpeed,
      doublingWallSegmentsDeltaMetresPerSecond: fine.meanSpeedMetresPerSecond - reference.meanSpeedMetresPerSecond,
      alternativeBendDeltaMetresPerSecond: alternative.meanSpeedMetresPerSecond - fine.meanSpeedMetresPerSecond,
    }),
  );
}
