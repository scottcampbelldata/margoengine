import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  prepareGeoTrack,
  geoPositionAt,
  geoTrail,
  wmtsTimeURL,
  wmtsTimeSource,
  SGP4,
  parseOMM,
  satelliteTrack,
} from '../dist/geo-time.js';
const track = prepareGeoTrack({
  id: 'dateline',
  times: [1704067200000, 1704067201000, 1704067203000],
  positions: [179, 0, 0, -179, 2, 100, -175, 6, 300],
});
test('keyframes preserve double precision, exact keys, dateline continuity and availability', () => {
  const decimal = prepareGeoTrack({ id: 'exact', times: [0, 1], positions: [0.1, 0.2, 1.1, 180, 0, 0] });
  assert.deepEqual(geoPositionAt(decimal, 0), [0.1, 0.2, 1.1]);
  assert.deepEqual(geoPositionAt(decimal, 1), [180, 0, 0]);
  assert.deepEqual(geoPositionAt(track, track.times[0]), [179, 0, 0]);
  assert.deepEqual(geoPositionAt(track, track.times[1]), [-179, 2, 100]);
  assert.deepEqual(geoPositionAt(track, track.times[0] + 500), [-180, 1, 50]);
  assert.equal(geoPositionAt(track, track.times[0] - 1), undefined);
  assert.deepEqual(geoPositionAt(track, track.times[0] - 1, { clamp: true }), [179, 0, 0]);
  assert.deepEqual(geoPositionAt(track, track.times[0] + 500, { interpolation: 'step' }), [179, 0, 0]);
  assert.throws(() => prepareGeoTrack({ id: 1, times: [0, 0], positions: [0, 0, 0, 1, 1, 1] }));
  assert.throws(() => prepareGeoTrack({ id: 1, times: [0], positions: [0, 91, 0] }));
});
test('trails include exact boundary interpolation and survive nonmonotone seeks without input mutation', () => {
  const trail = geoTrail(track, track.times[0] + 2000, 1500);
  assert.deepEqual([...trail.times], [track.times[0] + 500, track.times[1], track.times[0] + 2000]);
  assert.deepEqual([...trail.positions], [-180, 1, 50, -179, 2, 100, -177, 4, 200]);
  const old = geoTrail(track, track.times[1], 2000);
  geoTrail(track, track.times[2] + 500, 500);
  assert.deepEqual(old, geoTrail(track, track.times[1], 2000));
  assert.equal(geoTrail(track, track.times[0] - 1, 10), undefined);
  assert.equal(geoTrail(track, track.times[2] + 500, 100), undefined);
  assert.equal(geoTrail(track, track.times[1], 0).times.length, 1);
});
test('great circle interpolation follows the pole and has deterministic antipodal/coincident handling', () => {
  const path = (positions) => prepareGeoTrack({ id: 0, times: [0, 10], positions });
  const p = geoPositionAt(path([0, 80, 10, 180, 80, 30]), 5, { interpolation: 'great-circle' });
  assert.ok(Math.abs(p[1] - 90) < 1e-12);
  assert.equal(p[2], 20);
  assert.ok(geoPositionAt(path([0, 0, 0, 180, 0, 0]), 5, { interpolation: 'great-circle' }).every(Number.isFinite));
  assert.deepEqual(geoPositionAt(path([0, 0, 0, 0, 0, 10]), 5, { interpolation: 'great-circle' }), [0, 0, 5]);
});
test('WMTS KVP and REST preserve dimensions, encode time and pass fetch cancellation', async () => {
  const options = {
    url: 'https://maps.test/wmts?key=abc',
    layer: 'wind',
    matrixSet: 'global',
    parameters: { Elevation: '0' },
    matrixLabels: ['zero', 'one'],
  };
  const url = new URL(await wmtsTimeURL(options, 0, 1, 1, 0));
  assert.equal(url.searchParams.get('Time'), '1970-01-01T00:00:00.000Z');
  assert.equal(url.searchParams.get('TILEMATRIX'), 'one');
  assert.equal(url.searchParams.get('Elevation'), '0');
  assert.equal(url.searchParams.get('key'), 'abc');
  const rest = await wmtsTimeURL(
    { ...options, url: 'https://maps.test/{Layer}/{Time}/{TileMatrix}/{TileRow}/{TileCol}.png' },
    0,
    0,
    0,
    0,
  );
  assert.ok(rest.includes('/wind/1970-01-01T00%3A00%3A00.000Z/zero/0/0.png'));
  const abort = new AbortController();
  let signal;
  const source = wmtsTimeSource(
    {
      ...options,
      fetch: async (_, init) => {
        signal = init.signal;
        return new Response('pixels');
      },
    },
    0,
  );
  assert.equal(await (await source(0, 0, 0, abort.signal)).text(), 'pixels');
  assert.equal(signal, abort.signal);
  abort.abort();
  await assert.rejects(source(0, 0, 0, abort.signal));
  await assert.rejects(wmtsTimeURL(options, 0, 0, 1, 0));
});
test('satellite ground and altitude tracks use real pinned CelesTrak OMM and preserve millisecond keys', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../../../examples/assets/sciviz/geo-time/iss.json', import.meta.url)),
  )[0];
  const orbit = new SGP4(parseOMM(raw)),
    times = [orbit.elements.epoch, orbit.elements.epoch + 60000, orbit.elements.epoch + 120000];
  const ground = satelliteTrack(orbit, times),
    flight = satelliteTrack(orbit, times, { ground: false });
  assert.deepEqual([...ground.times], times);
  assert.ok(flight.positions[2] > 300000 && flight.positions[2] < 500000);
  for (let i = 2; i < ground.positions.length; i += 3) assert.equal(ground.positions[i], 0);
});
test('real-data and numerical-reference fixtures match their provenance hashes', () => {
  const root = new URL('../../../examples/assets/sciviz/geo-time/', import.meta.url),
    record = JSON.parse(readFileSync(new URL('source.json', root)));
  for (const file of record.files) {
    const bytes = readFileSync(new URL(file.file, root));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  const ais = JSON.parse(readFileSync(new URL('ais.json', root)));
  assert.equal(ais.tracks.length, 12);
  for (const vessel of ais.tracks) {
    const data = prepareGeoTrack({
      id: vessel.id,
      times: vessel.records.map((r) => r.time),
      positions: vessel.records.flatMap((r) => r.position),
    });
    assert.ok(data.times.length >= 10);
    assert.ok(data.positions[0] < -73.5);
  }
});
