// The Fauld places on the CPU: both entries share one world (places, slots, size), every place and building slot lies
// inside the 6.4 km square, the building and cattle slots are named and empty, and every Fauld shot file under
// tools/shot/shots names its place, era and sky, keeps its camera inside the world and looks at its subject.
// The drawing is proved on a real GPU by fauld-still.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as countryside from '@margoengine/scenes/fauld-countryside';
import * as crater from '@margoengine/scenes/fauld-crater';
import { scenes } from '@margoengine/scenes';

const shots = new URL('../../../tools/shot/shots/', import.meta.url);

test('both entries share one world: the same size, centre, places and slots', () => {
  assert.equal(countryside.FAULD_SIZE, 6400);
  assert.equal(crater.FAULD_PLACES, countryside.FAULD_PLACES);
  assert.equal(crater.FAULD_SLOTS, countryside.FAULD_SLOTS);
  assert.deepEqual(countryside.FAULD_CENTRE, { easting: 418225, northing: 327725 });
  assert.equal(typeof countryside.attach, 'function');
  assert.equal(typeof crater.attach, 'function');
});

test('every place and slot is inside the world; the crater is the origin', () => {
  const half = countryside.FAULD_SIZE / 2;
  assert.deepEqual([...countryside.FAULD_PLACES.crater], [0, 0]);
  for (const [name, at] of Object.entries(countryside.FAULD_PLACES))
    assert.ok(Math.abs(at[0]) < half && Math.abs(at[1]) < half, `${name} at ${at}`);
  for (const name of ['church', 'inn', 'cottages', 'farmhouse', 'kilnWorks', 'guardHut', 'cattle']) {
    const slot = countryside.FAULD_SLOTS[name];
    assert.ok(slot, `${name} slot`);
    assert.ok(Math.abs(slot.at[0]) < half && Math.abs(slot.at[1]) < half);
    assert.ok(Number.isFinite(slot.turn));
  }
  assert.ok(Object.isFrozen(countryside.FAULD_SLOTS) && Object.isFrozen(countryside.FAULD_PLACES));
});

test('the slot models are the Tripo set, each standing only in its eras (no cattle on the 1944 crater day)', () => {
  const tripo = new Set([
    'church_st_werburgh',
    'cock_inn',
    'cottage_row',
    'kiln_works',
    'guard_hut',
    'nfs_tender',
    'wvs_van',
    'cattle',
  ]);
  for (const [name, slot] of Object.entries(countryside.FAULD_SLOTS)) {
    if (slot.model !== undefined) assert.ok(tripo.has(slot.model), `${name} model ${slot.model}`);
    assert.ok(slot.eras.length > 0 && slot.eras.every((e) => ['before', '1944', 'today'].includes(e)), name);
  }
  assert.ok(!countryside.FAULD_SLOTS.cattle.eras.includes('1944'));
  assert.deepEqual([...countryside.FAULD_SLOTS.nfsTender.eras], ['1944']);
});

// The tunnel rows share the fr numbering; they are read by the next test.
const tunnelRow = (s) => s.shot.scene === 'fauld-tunnels';
const FAULD_TUNNEL_STATES = scenes.find((scene) => scene.name === 'fauld-tunnels').settings.state.options;

test('every Fauld shot file names its place, era and sky and keeps its camera in the world, looking at its subject', () => {
  const files = readdirSync(shots).filter((f) => /^fauld-fr\d{3}\.json$/.test(f));
  const outdoor = files.filter((f) => !tunnelRow(JSON.parse(readFileSync(new URL(f, shots), 'utf8'))));
  assert.equal(outdoor.length, 81);
  const half = countryside.FAULD_SIZE / 2;
  for (const f of outdoor) {
    const s = JSON.parse(readFileSync(new URL(f, shots), 'utf8'));
    assert.equal(s.format, 'margo-cutscene', f);
    // The tool's page with its query; the tool adds the page's ground under the camera and target (page.ground).
    assert.equal(s.shot.page.path, 'packages/scenes/test/fauld-still.html', f);
    const q = new URLSearchParams(s.shot.page.query);
    assert.ok(['crater', 'countryside'].includes(q.get('place')), `${f} place`);
    assert.ok(['before', '1944', 'today'].includes(q.get('era')), `${f} era`);
    assert.ok(
      ['dawn', 'lowSun', 'overcast', 'grey', 'dusk', 'night', 'snow', 'rain', 'mist'].includes(q.get('sky')),
      `${f} sky`,
    );
    assert.equal(s.shot.page.ground, 'fauldStill.height', f);
    assert.ok(s.shot.probes.mid > 0 && s.shot.probes.mid < s.duration, `${f} mid probe`);
    assert.ok(s.shot.subject.target.every(Number.isFinite) && s.shot.subject.size > 0, `${f} subject`);
    const cam = s.tracks.find((t) => t.type === 'camera');
    for (const k of cam.keys) {
      assert.ok(
        k.position.every(Number.isFinite) && Math.abs(k.position[0]) < half && Math.abs(k.position[2]) < half,
        f,
      );
      assert.ok(k.position[1] >= 0.3, `${f} camera ${k.position[1]} m above the ground`);
      assert.ok(k.fov > 1 && k.fov < 120, `${f} fov ${k.fov}`);
      const d = Math.hypot(k.target[0] - k.position[0], k.target[2] - k.position[2]);
      assert.ok(d > 1, `${f} camera stands on its target`);
    }
  }
});

test('every Fauld tunnel shot file names its place, era and lighting state and keeps its camera off the floor, looking at its subject', () => {
  const files = readdirSync(shots).filter((f) => /^fauld-fr\d{3}\.json$/.test(f));
  const tunnels = files
    .map((f) => [f, JSON.parse(readFileSync(new URL(f, shots), 'utf8'))])
    .filter(([, s]) => tunnelRow(s));
  assert.equal(tunnels.length, 56);
  for (const [f, s] of tunnels) {
    assert.equal(s.format, 'margo-cutscene', f);
    assert.equal(s.shot.page.path, 'examples/fauld/index.html', f);
    const q = s.shot.page.query;
    assert.equal(q.place, 'tunnels', f);
    assert.equal(q.era, '1944', f);
    assert.ok(FAULD_TUNNEL_STATES.includes(q.state), `${f} state ${q.state}`);
    assert.equal(`fauld-${q.shot}.json`, f);
    assert.ok(s.shot.probes.mid > 0 && s.shot.probes.mid < s.duration, `${f} mid probe`);
    assert.ok(s.shot.subject.target.every(Number.isFinite) && s.shot.subject.size > 0, `${f} subject`);
    const cam = s.tracks.find((t) => t.type === 'camera');
    for (const k of cam.keys) {
      assert.ok(k.position.every(Number.isFinite), f);
      assert.ok(k.position[1] >= 0.1, `${f} camera ${k.position[1]} m above the floor`);
      assert.ok(k.fov > 1 && k.fov < 120, `${f} fov ${k.fov}`);
      const d = Math.hypot(...k.target.map((v, i) => v - k.position[i]));
      assert.ok(d > 0.1, `${f} camera stands on its target`);
    }
  }
});
