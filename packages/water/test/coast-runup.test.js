// KB-WATER-SWASH1: Water's coast flow runs a wave up a beach as far as the published results, carries a bore at its
// Rankine-Hugoniot speed and keeps a lake at rest, on test/coast-reference.js, the shader's step written in float64.
// The GPU's run-up on a beach under a real swell is pinned by test/surf.browser.mjs against Stockdon et al. 2006.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coastStep } from './coast-reference.js';
import { riverModel } from './rivers-reference.js';
import { solitary, solitaryRunup, stoker } from './flood-analytic.js';
import { G } from './flood-reference.js';

// A one-cell-wide channel along x: a row of water between two rows of wall (ground 100 m, dry), closed at both ends.
function channel(n, cell, bed) {
  const width = n + 2,
    ground = new Float64Array(width * 3).fill(100);
  for (let i = 0; i < n; i++) ground[width + i + 1] = bed((i + 0.5) * cell);
  return riverModel({ ground, width, height: 3, cell });
}
const row = (m, i) => m.width + i + 1;

test('the coast step is the one the shader runs', () => {
  // The kernel's defining lines, so the reference above cannot drift from it unseen.
  const coastal = readFileSync(new URL('../src/coastal.ts', import.meta.url), 'utf8');
  for (const line of [
    'let bed=max(a.y,b.y);let h=max(za,zb)-bed;if(h<=COAST_DRY){return 0.0;}',
    'let pressure=0.5*(max(0.0,za-bed)+max(0.0,zb-bed));',
    'if(mean[c]>0.0){star[c]=u[w]+koren(u[w]-u[w-1],u[w+1]-u[w]);}else{star[c]=u[w+1]+koren(u[w+1]-u[w+2],u[w]-u[w+1]);}',
    'var flux=(mean[1]*star[1]-mean[0]*star[0])/along;',
    'flux+=(qn*select(u[6],u[2],qn>0.0)-qs*select(u[2],u[5],qs>0.0))/across;',
    'var moved=q-dt*flux-dt*9.81*pressure*(zb-za)/along;',
    'moved/=1.0+dt*9.81*COAST_MANNING*COAST_MANNING*abs(moved)/pow(h,2.3333333);',
    'let cap=h*0.5*min(frame.flow.y,frame.flow.z)/dt;return clamp(moved,-cap,cap);',
    'const COAST_MANNING=0.02;',
  ])
    assert.ok(coastal.includes(line), `coastal.ts lost: ${line}`);
});

test('a solitary wave runs up a plane beach as Synolakis 1987 gives (NOAA canonical case) within 5%', (t) => {
  // H / d = 0.0185 on 1 : 19.85: R / d = 2.831 sqrt(cot beta) (H / d)^(5/4) = 0.0861 (Synolakis 1987,
  // https://doi.org/10.1017/S002211208700329X; Synolakis et al. 2008, https://doi.org/10.1007/s00024-004-0427-y).
  // The virtual pipe the coast ran before ran it up 0.0129 (85% short): it drove each outflow by the depth of the cell
  // it left alone, carried no momentum and decayed every flow by 0.12 a second. Frictionless here, as the law is.
  const d = 1,
    H = 0.0185,
    cot = 19.85,
    dx = 0.05,
    n = Math.round(125 / dx),
    wave = solitary(H, d, cot * d + Math.acosh(Math.sqrt(20)) / Math.sqrt((3 * H) / (4 * d * d * d)) + 5),
    bed = (x) => (x - 5 < cot * d ? -(x - 5) / cot : -d),
    m = channel(n, dx, bed);
  for (let i = 0; i < n; i++) m.depth[row(m, i)] = Math.max(0, wave.eta((i + 0.5) * dx) - bed((i + 0.5) * dx));
  // Moving shoreward with the long-wave discharge of its height: the west outflow of the cell east of each face.
  for (let i = 0; i < n - 1; i++) {
    const x = (i + 1) * dx;
    if (x - 5 > (cot * d) / 2) {
      const eta = wave.eta(x);
      m.flux[row(m, i + 1) * 4] = Math.sqrt(G / d) * eta * (d + eta);
    }
  }
  const dt = (0.25 * dx) / Math.sqrt(G * (d + H));
  let runup = -Infinity;
  for (let t = 0; t < 30; t += dt) {
    coastStep(m, dt, 0);
    for (let i = 0; i < n; i++)
      if (m.depth[row(m, i)] > 1e-4) {
        runup = Math.max(runup, m.depth[row(m, i)] + m.ground[row(m, i)]);
        break;
      }
  }
  const law = solitaryRunup(H / d, cot);
  t.diagnostic(`run-up R / d ${(runup / d).toFixed(4)}, Synolakis 1987 ${law.toFixed(4)}`);
  assert.ok(Math.abs(runup / d / law - 1) < 0.05, `run-up R / d ${(runup / d).toFixed(4)} against ${law.toFixed(4)}`);
});

test('a dam break on a wet bed makes the bore of Stoker 1957: its depth and speed within 3%', (t) => {
  // Rankine-Hugoniot across the bore needs momentum carried through it and the pressure g h^2 / 2 differenced across
  // each face (Stoker 1957; SWASHES 4.1.1); h_r / h_l = 0.5. With the flow depth alone as the pressure depth the bore ran
  // 3.125 m/s, 5.6% fast.
  const dx = 0.05,
    n = 800,
    x0 = 20,
    s = stoker(1, 0.5, x0),
    m = channel(n, dx, () => 0);
  for (let i = 0; i < n; i++) m.depth[row(m, i)] = (i + 0.5) * dx < x0 ? 1 : 0.5;
  const dt = (0.2 * dx) / (Math.sqrt(G) + 2),
    duration = 4;
  for (let k = 0; k < Math.round(duration / dt); k++) coastStep(m, dt, 0);
  const elapsed = Math.round(duration / dt) * dt;
  // The bore is where the depth crosses halfway between the middle depth and the bed's.
  let front = 0;
  for (let i = n - 1; i >= 0; i--)
    if (m.depth[row(m, i)] > 0.5 * (s.hm + 0.5)) {
      front = (i + 1) * dx;
      break;
    }
  const speed = (front - x0) / elapsed,
    middle = m.depth[row(m, Math.round((x0 + elapsed * 0.5 * (2 * Math.sqrt(G) - 3 * Math.sqrt(G * s.hm) + s.shock)) / dx))];
  t.diagnostic(`bore ${speed.toFixed(3)} m/s, depth ${middle.toFixed(4)} m; Stoker ${s.shock.toFixed(3)} m/s, ${s.hm.toFixed(4)} m`);
  assert.ok(Math.abs(speed / s.shock - 1) < 0.03, `bore speed ${speed.toFixed(3)} m/s against ${s.shock.toFixed(3)}`);
  assert.ok(Math.abs(middle / s.hm - 1) < 0.03, `middle depth ${middle.toFixed(4)} m against ${s.hm.toFixed(4)}`);
});

test('a lake at rest over steps and an island stays at rest, and a closed basin keeps its water', () => {
  // Steps of 0.25 m and an island standing above the 1 m lake (Audusse et al. 2004's test of a well-balanced scheme).
  const width = 24,
    height = 16,
    ground = new Float64Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const island = Math.hypot(x - 12, y - 8) < 3;
      ground[y * width + x] = x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 5 : island ? 1.5 : (x % 4) * 0.25 - 0.5;
    }
  const m = riverModel({ ground, width, height, cell: 0.5 });
  for (let i = 0; i < ground.length; i++) m.depth[i] = Math.max(0, 1 - ground[i]);
  const still = m.depth.slice();
  let peak = 0;
  for (let k = 0; k < 2000; k++) peak = Math.max(peak, coastStep(m, 1 / 90));
  assert.equal(peak, 0, 'the lake moved');
  assert.deepEqual(m.depth, still);
  // Then a hump in the same basin: it sloshes for 20 s and the volume stays (summed in doubles).
  const volume = () => m.depth.reduce((a, b) => a + b, 0);
  m.depth[5 * width + 5] += 0.5;
  const before = volume();
  for (let k = 0; k < 1800; k++) coastStep(m, 1 / 90);
  assert.ok(Math.abs(volume() / before - 1) < 1e-12, `volume ${volume()} against ${before}`);
  assert.ok(m.depth.every((d) => d >= 0));
});
