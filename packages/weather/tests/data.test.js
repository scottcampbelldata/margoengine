// METAR reading against reports written by hand from the code form (WMO-No. 306 FM 15, ICAO Annex 3, FMH-1), and against
// 798 real reports from 50 aerodromes (NOAA Aviation Weather Center, fixtures/metar/NOTICE.md): every one reads with
// no group left over, and its state is valid and agrees with what the report says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { metarState, parseMetar, weatherFromMetar } from '../dist/data.js';
import { assertState, fogDensity } from '../dist/index.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
const reports = ['metar.txt', 'metar2.txt'].flatMap((file) =>
  readFileSync(new URL(`fixtures/metar/${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean),
);

test('an ICAO report: wind, visibility, weather, cloud, temperature and QNH in SI units', () => {
  const m = parseMetar('METAR EGLL 071150Z 24015G27KT 210V270 4000 -SHRA BKN014 SCT025CB 12/09 Q1003 RERA NOSIG');
  assert.equal(m.station, 'EGLL');
  assert.deepEqual(m.time, { day: 7, hour: 11, minute: 50 });
  assert.equal(m.wind.from, 240);
  near(m.wind.speed, (15 * 1852) / 3600);
  near(m.wind.gust, (27 * 1852) / 3600);
  assert.deepEqual(m.wind.variable, [210, 270]);
  assert.equal(m.visibility, 4000);
  assert.deepEqual(m.weather, [{ intensity: 'light', descriptor: 'SH', phenomena: ['RA'], text: '-SHRA' }]);
  assert.deepEqual(m.clouds, [
    { cover: 'BKN', height: 1400 * 0.3048, type: undefined },
    { cover: 'SCT', height: 2500 * 0.3048, type: 'CB' },
  ]);
  assert.equal(m.temperature, 12);
  assert.equal(m.dewPoint, 9);
  assert.equal(m.pressure, 1003);
  assert.deepEqual(m.recent, ['RERA']);
  assert.equal(m.trend, 'NOSIG');
  assert.deepEqual(m.unknown, []);
});

test('a United States report: statute miles with fractions, inches of mercury, CLR, remarks', () => {
  const m = parseMetar('KDEN 071753Z AUTO 36008KT 1 1/2SM -SN BR OVC008 M02/M04 A2992 RMK AO2 SLP150 P0001');
  assert.equal(m.kind, 'METAR');
  assert.equal(m.auto, true);
  near(m.visibility, 1.5 * 1609.344);
  assert.deepEqual(
    m.weather.map((w) => w.text),
    ['-SN', 'BR'],
  );
  assert.equal(m.temperature, -2);
  assert.equal(m.dewPoint, -4);
  near(m.pressure, 29.92 * 33.8639);
  assert.equal(m.remarks, 'AO2 SLP150 P0001');
  near(parseMetar('KXYZ 010000Z 00000KT M1/4SM FG VV002 01/01 A3001').visibility, 0.25 * 1609.344);
  assert.equal(parseMetar('KXYZ 010000Z 00000KT M1/4SM FG VV002 01/01 A3001').verticalVisibility, 200 * 0.3048);
  assert.equal(parseMetar('KXYZ 010000Z 00000KT 10SM CLR 20/10 A3001').clear, true);
});

test('CAVOK, variable and calm wind, metres per second, NIL and missing values', () => {
  const a = parseMetar('SPECI UUEE 071200Z VRB02MPS CAVOK M05/M08 Q1025=');
  assert.equal(a.kind, 'SPECI');
  assert.equal(a.wind.from, undefined);
  assert.equal(a.wind.speed, 2);
  assert.equal(a.cavok, true);
  assert.equal(a.visibility, 10000);
  assert.equal(parseMetar('LFPG 071200Z 00000KT 9999 NSC 10/05 Q1020').wind.speed, 0);
  assert.equal(parseMetar('LFPG 071200Z NIL').wind, undefined);
  const b = parseMetar('EDDF 071200Z /////KT //// // ///////// //// Q////');
  assert.equal(b.wind, undefined);
  assert.equal(b.visibility, undefined);
  assert.throws(() => parseMetar('hello'), SyntaxError);
  assert.throws(() => parseMetar(42), TypeError);
});

test('present weather groups: intensity, descriptor and stacked phenomena', () => {
  const w = parseMetar('KMIA 071200Z 09010KT 2SM +TSRAGR VCSH FZFG BLSN 25/24 A2990').weather;
  assert.deepEqual(w[0], { intensity: 'heavy', descriptor: 'TS', phenomena: ['RA', 'GR'], text: '+TSRAGR' });
  assert.deepEqual(w[1], { intensity: 'vicinity', descriptor: 'SH', phenomena: [], text: 'VCSH' });
  assert.equal(w[2].descriptor, 'FZ');
  assert.equal(w[3].descriptor, 'BL');
  assert.deepEqual(parseMetar('KMIA 071200Z 09010KT 9999 XYZZY 25/24 A2990').unknown, ['XYZZY']);
});

test('metarState: precipitation by intensity, lightning, gusts, cloud by oktas', () => {
  const s = weatherFromMetar('EGLL 071150Z 24010G15KT 4000 +TSRAGR SCT020 BKN040CB 12/09 Q1003');
  assertState(s);
  assert.equal(s.rain, 0.95);
  assert.equal(s.hail, 0.95);
  assert.equal(s.lightning, 0.9);
  near(s.gust, 0.5);
  assert.equal(s.cloud, 6 / 8);
  assert.equal(weatherFromMetar('EGLL 071150Z 24010KT 9999 -DZ FEW020 12/09 Q1003').rain, 0.15);
  const sleet = weatherFromMetar('CYUL 071150Z 05010KT 3SM PL OVC010 00/M01 A2990');
  assert.equal(sleet.rain, 0.3);
  assert.equal(sleet.snow, 0.3);
  assert.equal(sleet.cloud, 1);
  assert.equal(weatherFromMetar('KXYZ 010000Z 00000KT 1/4SM FG VV001 01/01 A3001').cloud, 1);
  assert.equal(weatherFromMetar('KXYZ 010000Z 00000KT 10SM VCTS SCT050CB 25/20 A3001').lightning, 0.3);
});

test('metarState: wind blows toward the opposite of where it comes from, north at -Z', () => {
  const toward = (text, o) => {
    const s = weatherFromMetar(text, o);
    return [Math.sin(s.windDirection) * s.wind, Math.cos(s.windDirection) * s.wind];
  };
  const v = (12 * 1852) / 3600;
  // From the north: toward the south, +Z. From the east: toward the west, -X. From 225 (south-west): toward NE.
  const n = toward('EGLL 071150Z 36012KT 9999 12/09 Q1003');
  near(n[0], 0, 1e-9);
  near(n[1], v);
  const e = toward('EGLL 071150Z 09012KT 9999 12/09 Q1003');
  near(e[0], -v);
  near(e[1], 0, 1e-9);
  const sw = toward('EGLL 071150Z 22512KT 9999 12/09 Q1003');
  near(sw[0], v * Math.SQRT1_2);
  near(sw[1], -v * Math.SQRT1_2);
  // A world with north along +X turns the wind with it: from the north blows toward -X.
  const turned = toward('EGLL 071150Z 36012KT 9999 12/09 Q1003', { north: Math.PI / 2 });
  near(turned[0], -v);
  near(turned[1], 0, 1e-9);
});

test('metarState: fog gives back the visibility through fogDensity (Koschmieder, 5 percent contrast)', () => {
  for (const metres of [300, 800, 1500, 3000, 6000]) {
    const s = weatherFromMetar(`EGLL 071150Z 00000KT ${String(metres).padStart(4, '0')} BR 12/09 Q1003`);
    near(fogDensity(s), 3 / metres, 1e-12);
  }
  // Below 150 m the fog is at its thickest, the densest fogDensity gives.
  assert.equal(weatherFromMetar('EGLL 071150Z 00000KT 0100 FG 12/09 Q1003').fog, 1);
  // Rain thickens fogDensity by itself, so the fog field leaves that part out and the extinction still matches.
  const wet = weatherFromMetar('EGLL 071150Z 00000KT 2000 RA 12/09 Q1003');
  near(fogDensity(wet), 3 / 2000, 1e-12);
});

test('every real report reads with nothing left over, and its state is valid and follows the report', () => {
  assert.ok(reports.length > 700, `${reports.length} reports`);
  const stations = new Set();
  let wet = 0,
    snowy = 0,
    stormy = 0;
  for (const text of reports) {
    const m = parseMetar(text);
    stations.add(m.station);
    assert.deepEqual(m.unknown, [], text);
    assert.ok(m.wind === undefined || (m.wind.speed >= 0 && m.wind.speed < 80), text);
    assert.ok(m.visibility === undefined || (m.visibility > 0 && m.visibility <= 30 * 1609.344), text);
    assert.ok(m.temperature === undefined || (m.temperature > -70 && m.temperature < 60), text);
    assert.ok(m.pressure === undefined || (m.pressure > 900 && m.pressure < 1090), text);
    const s = metarState(m);
    assertState(s);
    const has = (p) => m.weather.some((w) => w.intensity !== 'vicinity' && w.phenomena.includes(p));
    assert.equal(s.rain > 0, has('RA') || has('DZ') || has('PL') || has('UP'), text);
    assert.equal(s.snow > 0, has('SN') || has('SG') || has('PL'), text);
    assert.equal(
      s.lightning > 0,
      m.weather.some((w) => w.descriptor === 'TS'),
      text,
    );
    if (s.rain > 0) wet++;
    if (s.snow > 0) snowy++;
    if (s.lightning > 0) stormy++;
  }
  assert.ok(stations.size >= 45, `${stations.size} stations`);
  assert.ok(wet > 50 && snowy > 10 && stormy > 10, `rain ${wet}, snow ${snowy}, thunder ${stormy}`);
});

test('a wind of 100 kt or more (P99KT, P49MPS) reads as its least value, not as an unknown group', () => {
  // WMO code table 0 08 054: P means the speed is greater than the one written.
  const a = parseMetar('RJTT 071200Z 240P99KT 9999 FEW020 25/20 Q0990');
  near(a.wind.speed, 100 * (1852 / 3600));
  assert.equal(a.wind.from, 240);
  assert.deepEqual(a.unknown, []);
  const b = parseMetar('UUEE 071200Z 27045GP49MPS 9999 SCT020 05/01 Q0980');
  assert.equal(b.wind.speed, 45);
  assert.equal(b.wind.gust, 50);
  assert.deepEqual(b.unknown, []);
});
