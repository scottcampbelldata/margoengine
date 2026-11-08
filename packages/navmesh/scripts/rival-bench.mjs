// One mesh, build time and path length, against recast-navigation installed outside the repository.
// The rival is a black box (engine-bench/batch-167/navmesh.mjs). This file never names its functions.
// The triangle soup and the config live here and are passed in. Busy machine: diagnostic times only.
import { Navigation } from '../dist/build.js';
import { line, rivalUrl, rivalVersion } from '../../../scripts/rival-pair.mjs';

const ROUNDS = 7;
const config = {
  cs: 0.25,
  ch: 0.2,
  walkableSlopeAngle: 60,
  walkableHeight: 2,
  walkableClimb: 2,
  walkableRadius: 1,
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
  borderSize: 0,
  buildBvTree: true,
};

/** One quad at y = 0. Winding is the one both builders accept (two-sided on the Margo side). */
function quad(parts, x0, z0, x1, z1) {
  const b = parts.positions.length / 3;
  parts.positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
  parts.indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
}

/** Four floor quads with a gap in the middle, so a path from west to east goes through a hall. */
function gapped() {
  const parts = { positions: [], indices: [] };
  quad(parts, -10, -8, -1, 8);
  quad(parts, 1, -8, 10, 8);
  quad(parts, -10, 8, 10, 10);
  quad(parts, -10, -10, 10, -8);
  return {
    positions: Float32Array.from(parts.positions),
    indices: Uint32Array.from(parts.indices),
    start: { x: -8, y: 0.2, z: 0 },
    end: { x: 8, y: 0.2, z: 0 },
  };
}

function openFloor() {
  return {
    positions: Float32Array.from([-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10]),
    indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
    start: { x: -8, y: 0, z: -8 },
    end: { x: 8, y: 0, z: 8 },
  };
}

function lengthOf(points) {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    n += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return n;
}

const rival = await import(rivalUrl('navmesh.mjs'));
await rival.load();
const version = rivalVersion('recast-navigation');

async function timeBoth(scene, what) {
  const roundsA = [];
  const roundsB = [];
  for (let i = 0; i < 2; i++) {
    const nav = await Navigation.create(scene.positions, scene.indices, config);
    const mesh = rival.build(scene.positions, scene.indices, config);
    if (what === 'path') {
      nav.path(scene.start, scene.end);
      rival.pathOf(mesh, scene.start, scene.end);
    }
    nav.dispose();
  }
  let margoPoints;
  let rivalPoints;
  for (let i = 0; i < ROUNDS; i++) {
    const margoFirst = i % 2 === 0;
    const order = margoFirst ? ['margo', 'rival'] : ['rival', 'margo'];
    let builtMargo;
    let builtRival;
    for (const who of order) {
      if (what === 'build') {
        const t0 = performance.now();
        if (who === 'margo') builtMargo = await Navigation.create(scene.positions, scene.indices, config);
        else builtRival = rival.build(scene.positions, scene.indices, config);
        const ms = performance.now() - t0;
        if (who === 'margo') roundsA.push(ms);
        else roundsB.push(ms);
      } else {
        builtMargo = await Navigation.create(scene.positions, scene.indices, config);
        builtRival = rival.build(scene.positions, scene.indices, config);
        const t0 = performance.now();
        if (who === 'margo') margoPoints = builtMargo.path(scene.start, scene.end);
        else rivalPoints = rival.pathOf(builtRival, scene.start, scene.end).points;
        const ms = performance.now() - t0;
        if (who === 'margo') roundsA.push(ms);
        else roundsB.push(ms);
      }
    }
    if (what === 'build') {
      margoPoints = builtMargo.path(scene.start, scene.end);
      rivalPoints = rival.pathOf(builtRival, scene.start, scene.end).points;
    }
    builtMargo.dispose();
  }
  return { roundsA, roundsB, margoPoints, rivalPoints };
}

const scene = gapped();
const build = await timeBoth(scene, 'build');
const path = await timeBoth(scene, 'path');
const floor = openFloor();
const floorNav = await Navigation.create(floor.positions, floor.indices, config);
const floorMesh = rival.build(floor.positions, floor.indices, config);
const floorMargo = floorNav.path(floor.start, floor.end);
const floorRival = rival.pathOf(floorMesh, floor.start, floor.end);
floorNav.dispose();

const margoLen = lengthOf(build.margoPoints ?? []);
const rivalLen = lengthOf(build.rivalPoints ?? []);
const euclid = Math.hypot(16, 16);
const floorMargoLen = lengthOf(floorMargo ?? []);
const floorRivalLen = lengthOf(floorRival.points ?? []);

if (!build.margoPoints || !build.rivalPoints || !floorMargo || !floorRival.success) {
  console.error('a path failed', {
    gappedMargo: build.margoPoints,
    gappedRival: build.rivalPoints,
    floorMargo,
    floorRival,
  });
  process.exit(1);
}

console.log(`recast-navigation ${version}`);
console.log(line('gapped build', 'margo', Math.min(...build.roundsA), 'recast', Math.min(...build.roundsB)));
console.log(line('gapped path query', 'margo', Math.min(...path.roundsA), 'recast', Math.min(...path.roundsB)));
console.log(`gapped length margo ${margoLen} recast ${rivalLen}`);
console.log(`gapped points margo ${JSON.stringify(build.margoPoints)}`);
console.log(`gapped points recast ${JSON.stringify(build.rivalPoints)}`);
console.log(`open floor length margo ${floorMargoLen} recast ${floorRivalLen} euclidean ${euclid}`);
console.log(`rounds build margo ${build.roundsA.map((v) => v.toFixed(3)).join(' ')}`);
console.log(`rounds build recast ${build.roundsB.map((v) => v.toFixed(3)).join(' ')}`);
console.log(`rounds path margo ${path.roundsA.map((v) => v.toFixed(3)).join(' ')}`);
console.log(`rounds path recast ${path.roundsB.map((v) => v.toFixed(3)).join(' ')}`);
