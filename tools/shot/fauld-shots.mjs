// Shot files for the Fauld crater and countryside rows of the recut shot list (channel-films Docs/fauld-shot-list-recut.csv):
//   node tools/shot/fauld-shots.mjs [--csv=<path>]   writes tools/shot/shots/fauld-frNNN.json, one per row
// Each row's camera text gives the lens (on the film pipeline's Super 35 filmback, 24.89 x 14 mm: the field of view is
// that of the 14 mm frame height, so the gates read back the same focal length), the height (drone N m, N m up),
// the distance (from N m, N km) and the move (dolly, push, pull back, orbit, pan, crane, rise, descend, track, slide,
// tilt); its visual names the subject (Hanbury, the works, the reservoir, the farm, the crater, the valley, the fields).
// Camera heights are above the ground under the camera and under the target: the shot tool adds the page's ground
// (`shot.page.ground`, fauldStill.height of packages/scenes/test/fauld-still.html).
// The place, era and sky go in the page query; `shot.subject` names the target and the subject's width. Places: FAULD_PLACES of @margoengine/scenes/fauld-world.
// The blast rows (set margo:scenes/fauld-blast) take their film second, subject and aim from BLAST below, and frame the
// whole column when the row's visual is the column: the lens is the row's own, or the longest band lens that holds the
// column (its height and width at the shot's middle from BlastCloud, built packages) when the row's is too long.
// Every camera is checked for a clear sight of its subject (fauld-sight.mjs) and turned or lifted until it has one;
// tools/shot/fauld-sight.json records each row's turn, lift and measures (build:packages first; the asset library).
// It also writes packages/scenes/test/fauld-blast-ground.json: the OS Terrain 50 ground under every blast camera key
// (--dem=<grid .f32>, default the asset library's dem/os-terrain-50/fauld_sk12_sk23.f32 beside the Projects folder),
// which the scenes test reads to keep each blast camera clear under the cloud deck (the grid is not in the repository).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FAULD_CENTRE, FAULD_SIZE } from '../../packages/scenes/dist/fauld-countryside.js';
import { BlastCloud } from '../../packages/weather/dist/eruption.js';
import { clearestShot } from '../../packages/cameras/dist/clearance.js';
import { fauldSight } from './fauld-sight.mjs';

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const csv = readFileSync(arg('csv', '../channel-films/Docs/fauld-shot-list-recut.csv'), 'utf8');
const parse = (text) => {
  const rows = [];
  let row = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])));
};
const PLACES = {
  crater: [0, 0],
  farm: [0, 10],
  hanbury: [-1225, -175],
  church: [-1190, -190],
  inn: [-1120, -120],
  works: [120, -780],
  reservoir: [210, -430],
  dove: [-300, -2600],
  fields: [-450, 420],
};
// How wide each subject is, metres (the film pipeline's framing and focus checks read `shot.subject`), at most the
// frame's width at the subject.
const SIZES = {
  crater: 230,
  farm: 60,
  hanbury: 400,
  church: 30,
  inn: 20,
  works: 200,
  reservoir: 300,
  dove: 300,
  fields: 400,
};
// Blast rows: the film second since the first explosion at the shot's start, what the shot is about (`column`: the
// whole cloud; `base`: the fire at its foot; or a place of PLACES), the aim's height above the ground for a place, the
// camera's bearing from the subject when the row names where it stands (radians, 0 east, pi/2 south, -pi/2 north),
// the distance when the visual names none, and the mud. Mud rows show the fresh crater (era 1944).
const BLAST = {
  fr001: { t: 0.5, what: 'column' },
  fr002: { t: 2, what: 'column' },
  fr004: { t: 18, what: 'column' },
  fr006: { t: 90, what: 'slope', aim: 0, mud: true },
  fr007: { t: 75, what: 'column', bearing: -Math.PI / 2 + 0.12 },
  fr054: { t: 0.4, what: 'column' },
  fr055: { t: 8, what: 'column' },
  fr056: { t: 1.5, what: 'column', bearing: -Math.PI / 2 + 0.12, dist: 2600 },
  fr057: { t: 30, what: 'dump', aim: 12 },
  fr058: { t: 45, what: 'column' },
  fr059: { t: 25, what: 'column', dist: 2800 },
  fr060: { t: 6, what: 'base' },
  fr061: { t: 8, what: 'crater', aim: 40 },
  fr064: { t: 10, what: 'landing', aim: 2, dist: 60 },
  fr072: { t: 120, what: 'column', dist: 2800 },
  fr078: { t: 30, what: 'reservoir', aim: 0, mud: true },
  fr079: { t: 45, what: 'reservoir', aim: 0, mud: true },
  fr080: { t: 70, what: 'slope', aim: 0, mud: true },
  fr081: { t: 100, what: 'front', aim: 2, mud: true },
  fr082: { t: 130, what: 'front', aim: 0, mud: true },
  fr083: { t: 180, what: 'works', aim: 0, mud: true },
};
// The scene's explosions (FAULD_BLASTS of @margoengine/scenes/fauld-blast; heights above the source's ground).
const cloud = new BlastCloud({
  sources: [
    { at: 0, tnt: 2.2e6, speed: 120, position: [-40, 0, 10] },
    { at: 1.6, tnt: 1.8e6, speed: 110, position: [55, 0, -15] },
  ],
  altitude: 90,
  wind: 3,
  windDirection: 70,
  fireDuration: 6,
  seed: 1944,
});
const column = (t) => {
  let top = 0,
    spread = 0,
    x = 0,
    z = 0;
  const all = cloud.thermals(t);
  for (const th of all) {
    top = Math.max(top, th.centre[1] + th.thickness);
    spread = Math.max(spread, th.spread);
    x += th.centre[0] / all.length;
    z += th.centre[2] / all.length;
  }
  return { top, width: 2 * spread + 100, x, z };
};
Object.assign(PLACES, { slope: [175, -600], dump: [-150, 95], landing: [-330, 230], front: [150, -690] });
Object.assign(SIZES, { slope: 200, dump: 80, landing: 40, front: 60 });
// The longest lens of the bands at or under `mm` (a column too tall for the row's lens is framed whole on a wider one).
const atMost = (mm) => {
  let best = BANDS[0][0];
  for (const [lo, hi] of BANDS) {
    if (hi <= mm) best = hi;
    else if (lo <= mm) best = Math.floor(mm);
  }
  return best;
};
const subject = (r) => {
  const v = `${r.visual} ${r.fallback}`.toLowerCase();
  if (r.set.endsWith('fauld-crater')) return 'crater';
  if (/church|steeple|churchyard/.test(v)) return 'church';
  if (/cock inn/.test(v)) return 'inn';
  if (/hanbury|village/.test(v)) return 'hanbury';
  if (/reservoir/.test(v)) return 'reservoir';
  if (/works|kiln|mud|labourer|yard/.test(v)) return 'works';
  if (/farm|ridge/.test(v)) return 'farm';
  if (/dove|river|valley/.test(v)) return 'dove';
  return 'fields';
};
const skyOf = (look) => {
  const l = look.toLowerCase();
  if (/mist/.test(l)) return 'mist';
  if (/night/.test(l)) return 'night';
  if (/dusk/.test(l)) return 'dusk';
  if (/snow/.test(l)) return 'snow';
  if (/rain/.test(l)) return 'rain';
  if (/dawn/.test(l)) return 'dawn';
  if (/grey|smoke|dust|mud|steam/.test(l)) return 'grey';
  if (/overcast/.test(l)) return 'overcast';
  return 'lowSun';
};
// The film's named lens bands (channel-films rules_limits focal_bands_mm, section 12: wide 18 to 24 mm for places,
// natural 35 to 50, portrait 85 to 135). A lens the shot list names outside them (28 mm, 200 mm) is the nearest
// band's edge, so every shot is a lens a crew would pick for that framing.
const FILMBACK = [24.89, 14];
const BANDS = [
  [18, 24],
  [35, 50],
  [85, 135],
];
const inBand = (mm) => {
  if (BANDS.some(([lo, hi]) => mm >= lo && mm <= hi)) return mm;
  let best = BANDS[0][0];
  for (const edge of BANDS.flat()) if (Math.abs(edge - mm) < Math.abs(best - mm)) best = edge;
  return best;
};
// How far the subject crosses the frame over the shot, as a share of the frame width: a real crew's move carries the
// subject across the frame (the film's still_hits rule: at least 3 percent), so the aim drifts across the subject
// from one side to the other while the camera moves, never locked to its centre.
const DRIFT = 0.07;
// The lens: f/8 to f/11 for a subject 20 m or more across (rules section 18), focused at the harmonic mean of the
// subject's near and far faces so the depth of field covers it (thin lens, circle of confusion 0.03 mm full frame
// scaled to the 24.89 mm filmback; Potmesil and Chakravarty, "A lens and aperture camera model for synthetic image
// generation", SIGGRAPH 1981, https://doi.org/10.1145/965161.806818). f/11 only when f/8 does not cover the subject.
const COC_MM = (0.03 * FILMBACK[0]) / 36;
const dofLimits = (focalMm, stop, focusM) => {
  const H = (focalMm * focalMm) / (stop * COC_MM) / 1000 + focalMm / 1000;
  return [(H * focusM) / (H + focusM), focusM >= H ? Infinity : (H * focusM) / (H - focusM)];
};
const lensFor = (focalMm, distance, size) => {
  const near = Math.max(distance - size / 2, 0.5),
    far = distance + size / 2,
    focusDistance = Math.round(((2 * near * far) / (near + far)) * 10) / 10;
  for (const stop of [8, 11]) {
    const [n, f] = dofLimits(focalMm, stop, focusDistance);
    if (n <= near && f >= far) return { stop, focusDistance };
  }
  return { stop: 11, focusDistance };
};
const eraOf = (r) => (r.state === 'today' ? 'today' : r.state === 'morning' ? 'before' : '1944');
const hash = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261) / 4294967296;
const round = (v) => v.map((x) => Math.round(x * 1000) / 1000);
// The OS Terrain 50 grid (float32 metres, row 0 the northmost; its .json gives the size and corner), bilinear between
// sample centres like loadDem of fauld-world.ts.
const demPath = arg(
  'dem',
  fileURLToPath(new URL('../../../../Assets/dem/os-terrain-50/fauld_sk12_sk23.f32', import.meta.url)),
);
const demMeta = JSON.parse(readFileSync(demPath.replace(/\.f32$/, '.json'), 'utf8')),
  demBytes = readFileSync(demPath),
  dem = new Float32Array(demBytes.buffer, demBytes.byteOffset, demBytes.length / 4);
const demAt = (east, north) => {
  const c = demMeta.cellsize_m,
    fx = (east - demMeta.xll_easting - c / 2) / c,
    fz = (demMeta.ytop_northing - c / 2 - north) / c,
    i = Math.max(0, Math.min(demMeta.width - 2, Math.floor(fx))),
    j = Math.max(0, Math.min(demMeta.depth - 2, Math.floor(fz))),
    u = Math.max(0, Math.min(1, fx - i)),
    v = Math.max(0, Math.min(1, fz - j)),
    at = (a, b) => dem[b * demMeta.width + a];
  return (
    at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v
  );
};
// The ground the page may put under a camera at world (x, z): the grid there, or at the nearest point of the scene's
// square for a camera outside it (the terrain's edge), whichever is higher.
const half = FAULD_SIZE / 2,
  groundUnder = (x, z) =>
    Math.max(
      demAt(FAULD_CENTRE.easting + x, FAULD_CENTRE.northing - z),
      demAt(
        FAULD_CENTRE.easting + Math.max(-half, Math.min(half, x)),
        FAULD_CENTRE.northing - Math.max(-half, Math.min(half, z)),
      ),
    );
// The camera's sight to its subject over the scene's own ground, trees and hedges (fauld-sight.mjs, the sight check
// of @margoengine/cameras/clearance): each row's own place first, then turned about its subject, then lifted, the least
// that clears the lens, the foreground and the ground between (--library=<asset library>).
const sight = fauldSight({
  library: arg('library', fileURLToPath(new URL('../../../../Assets/blender-library', import.meta.url))),
  dem: demPath,
});
// How tall each subject stands, metres.
const HEIGHTS = {
  crater: 6,
  farm: 6,
  hanbury: 14,
  church: 25,
  inn: 8,
  works: 15,
  reservoir: 2,
  dove: 4,
  fields: 2,
  slope: 4,
  dump: 4,
  landing: 2,
  front: 3,
};
// Lifts in metres and turns in degrees, least first. Turns keep the camera in the south half (the sun behind or beside
// it); a row that names where it stands turns at most 12 degrees.
const LIFTS = [0, 0.5, 1.3, 2.5, 4.5, 8, 14, 22, 34];
const TURNS = [0, ...[6, 12, 18, 24, 30, 36, 42, 48, 60, 72, 84, 96, 108, 120, 132, 144].flatMap((k) => [k, -k])];
// Inside the wooded crater of today the trees are what the shot is about: they may stand between and about the camera,
// though not against the lens, over the near foreground (a fifth of the way) or filling the middle of the frame.
// Elsewhere the subject's foot must show too: 85 percent of its points, so a bank just before it does not hide it.
const OPEN = { subject: 0.85 };
const WOODED = { subject: 0.2, near: 0.2, foreground: 0.25, centre: 0.15 };
const sightReport = {};
const blastGround = {};
let n = 0;
for (const r of parse(csv)) {
  if (!/fauld-(crater|countryside|blast)$/.test(r.set)) continue;
  const b = r.set.endsWith('fauld-blast') ? BLAST[r.id] : null;
  if (r.set.endsWith('fauld-blast') && !b) throw new Error(`${r.id}: a blast row with no BLAST entry; add one`);
  const cam = r.camera.toLowerCase(),
    vis = r.visual.toLowerCase(),
    // A whole number of frames at 24 fps (the shot tool's rule).
    dur = Math.max(1, Math.round(Number(r.dur_s) * 24)) / 24,
    listed = inBand(Number(cam.match(/(\d+) mm/)?.[1] ?? (cam.includes('drone') ? 24 : 35))),
    drone = cam.match(/drone (\d+)(?: to (\d+))? m/),
    up = cam.match(/(\d+(?:\.\d+)?) m (?:up|high)|, (\d+(?:\.\d+)?) m,/),
    km = `${vis} ${cam}`.match(/(\d+(?:\.\d+)?) km/),
    from = `${vis} ${cam}`.match(/(?:from|at) (?:the [a-z ]+ )?(\d+) m\b/),
    whole = b?.what === 'column' || b?.what === 'base',
    what = b ? (whole ? 'crater' : b.what) : subject(r),
    col = b ? column(b.t + dur / 2) : null,
    [tx, tz] = whole ? [col.x, col.z] : PLACES[what],
    h0 = drone ? Number(drone[1]) : Number(up?.[1] ?? up?.[2] ?? 1.7),
    h1 = drone?.[2] ? Number(drone[2]) : h0;
  // Distance: named, else from the lens (a long lens stands far off), else from a drone's height.
  let dist = km
    ? Number(km[1]) * 1000
    : from
      ? Number(from[1])
      : drone
        ? Math.max(120, h0 * 1.4)
        : listed >= 135
          ? 450
          : listed >= 85
            ? 160
            : listed >= 50
              ? 60
              : 25;
  if (what === 'crater' && !drone && /rim|wood|memorial|stone|path|fence|birch|leaves/.test(vis))
    dist = Math.max(dist, 150);
  if (b?.dist) dist = b.dist;
  // A distance only that rule chose may step in towards the rim before the camera is lifted.
  const steps =
    what === 'crater' && !b && !drone && !km && !from && dist === 150 ? [dist, 0.85 * dist, 0.75 * dist] : [dist];
  // A column shot holds the whole cloud at the shot's middle: aimed at half its top, 1.3 of its height and 1.2 of its
  // width in frame, on the row's lens or the longest band lens that holds it.
  let lens = listed;
  if (b?.what === 'column') {
    const vfov = 2 * Math.atan((0.65 * col.top) / dist),
      hfov = 2 * Math.atan((0.6 * col.width) / dist);
    lens = Math.min(
      listed,
      atMost(Math.min(FILMBACK[1] / (2 * Math.tan(vfov / 2)), FILMBACK[0] / (2 * Math.tan(hfov / 2)))),
    );
  }
  const fov = (2 * Math.atan(FILMBACK[1] / 2 / lens) * 180) / Math.PI;
  // Look from the south half (the low November sun behind or beside the camera), bearing by row.
  const home = b?.bearing ?? Math.PI * (0.25 + 0.5 * hash(r.id)),
    tgtH = b
      ? b.what === 'column'
        ? Math.round(col.top / 2)
        : b.what === 'base'
          ? 90
          : b.aim
      : drone
        ? 0
        : what === 'crater' && /floor|up the|walls/.test(vis)
          ? 25
          : 2;
  const speed = Number(cam.match(/(\d+(?:\.\d+)?) m\/s/)?.[1] ?? 0.6),
    deg = Number(cam.match(/(\d+) deg/)?.[1] ?? 5) * (Math.PI / 180),
    travel = speed * dur;
  // The move from a bearing round the subject, raised by `lift` metres.
  const move = (bearing, lift, dist) => {
    const ox = Math.cos(bearing) * dist,
      oz = Math.sin(bearing) * dist,
      pos0 = [tx + ox, h0, tz + oz],
      tgt0 = [tx, tgtH, tz],
      fwd = [-ox / dist, -oz / dist],
      side = [-fwd[1], fwd[0]];
    let pos1 = [...pos0],
      tgt1 = [...tgt0];
    if (/orbit|arc/.test(cam)) {
      const b1 = bearing + deg;
      pos1 = [tx + Math.cos(b1) * dist, h1, tz + Math.sin(b1) * dist];
    } else if (/pull back/.test(cam)) pos1 = [pos0[0] - fwd[0] * dist * 0.4, h1, pos0[2] - fwd[1] * dist * 0.4];
    else if (/push|dolly/.test(cam)) pos1 = [pos0[0] + fwd[0] * travel, h1, pos0[2] + fwd[1] * travel];
    else if (/track|slide/.test(cam)) {
      pos1 = [pos0[0] + side[0] * travel, h1, pos0[2] + side[1] * travel];
      tgt1 = [tgt0[0] + side[0] * travel, tgt0[1], tgt0[2] + side[1] * travel];
    } else if (/pan/.test(cam)) tgt1 = [tx + side[0] * dist * Math.tan(deg), tgtH, tz + side[1] * dist * Math.tan(deg)];
    else if (/crane|rise/.test(cam)) {
      const c = cam.match(/crane (\d+) to (\d+) m|(\d+) m up to (\d+) m/);
      if (c) {
        pos0[1] = Number(c[1] ?? c[3]);
        pos1[1] = Number(c[2] ?? c[4]);
      } else pos1[1] = /down/.test(cam) ? Math.max(1, pos0[1] - travel) : pos0[1] + travel;
    } else if (/descen/.test(cam)) pos1[1] = Math.max(2, h0 - (drone ? h0 * 0.12 : travel));
    if (/tilt up/.test(cam)) tgt1 = [tgt0[0], tgt0[1] + dist * Math.tan(deg), tgt0[2]];
    else if (/tilt/.test(cam)) tgt1 = [tgt0[0], tgt0[1] - dist * Math.tan(deg), tgt0[2]];
    // The aim drifts across the subject (DRIFT of the frame width at the subject), across the camera's own sideways.
    const halfWidth = dist * (FILMBACK[0] / 2 / lens),
      drift = (DRIFT / 2) * 2 * halfWidth;
    tgt0[0] -= side[0] * drift;
    tgt0[2] -= side[1] * drift;
    tgt1[0] += side[0] * drift;
    tgt1[2] += side[1] * drift;
    pos0[1] += lift;
    pos1[1] += lift;
    return [
      [pos0, tgt0],
      [pos1, tgt1],
    ];
  };
  // The subject is what the frame holds of the place: never wider than the frame at the subject's distance (a shot from
  // among the fields frames a part of them, and a subject wider than the frame would put the camera inside it).
  const sizeAt = (d) =>
    Math.min(
      b?.what === 'column' ? Math.round(col.width) : b?.what === 'base' ? 300 : SIZES[what],
      Math.round(d * (FILMBACK[0] / lens)),
    );
  // The first clear camera, else the least blocked; checked at the move's start, middle and end.
  const scene = await sight(b ? (b.mud ? '1944' : 'before') : eraOf(r)),
    foot = [tx, scene.ground(tx, tz), tz],
    subjectHeight =
      b?.what === 'column' ? Math.round(col.top) : b?.what === 'base' ? 180 : Math.max(HEIGHTS[what], b?.aim ?? 0),
    world = ([p, t], size) => ({
      position: [p[0], p[1] + scene.ground(p[0], p[2]), p[2]],
      target: [t[0], t[1] + scene.ground(t[0], t[2]), t[2]],
      fov,
      subject: { centre: foot, width: size, height: subjectHeight },
    }),
    middle = (a, c) => ({
      ...a,
      position: a.position.map((v, i) => (v + c.position[i]) / 2),
      target: a.target.map((v, i) => (v + c.target[i]) / 2),
    });
  // Under an overcast sky there is no sun to keep behind the camera: any side of the subject will do.
  const sunless = ['overcast', 'grey', 'rain', 'snow', 'mist'].includes(b ? 'overcast' : skyOf(r.look)),
    turns = sunless ? [...TURNS, 156, -156, 168, -168, 180] : TURNS;
  let best;
  search: for (const lift of LIFTS)
    for (const [d, turn] of steps.flatMap((d) => turns.map((turn) => [d, turn]))) {
      const bearing = home + (turn * Math.PI) / 180;
      if (
        b?.bearing !== undefined
          ? Math.abs(turn) > 12
          : !sunless && (bearing < 0.1 * Math.PI || bearing > 0.9 * Math.PI)
      )
        continue;
      const keys = move(bearing, lift, d),
        [first, last] = keys.map((k) => world(k, sizeAt(d))),
        near = [
          ...(await scene.near(first.position[0], first.position[2], d)),
          ...(await scene.near(last.position[0], last.position[2], d)),
        ],
        { clearance } = clearestShot(
          [keys],
          () => [first, middle(first, last), last],
          {
            ground: scene.ground,
            occluders: [...new Set(near)],
          },
          b ? {} : eraOf(r) === 'today' && what === 'crater' ? WOODED : OPEN,
        );
      // Among views that stay blocked, a lift has to earn its height: a hundredth of a penalty point a metre.
      const score = clearance.penalty + lift / 100;
      if (clearance.clear || !best || score < best.score) best = { keys, turn, lift, distance: d, clearance, score };
      if (clearance.clear) break search;
    }
  const [[pos0, tgt0], [pos1, tgt1]] = best.keys,
    measure = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null),
    size = sizeAt(best.distance),
    optics = lensFor(lens, best.distance, size);
  sightReport[r.id] = {
    distance: Math.round(best.distance),
    turn: best.turn,
    lift: best.lift,
    clear: best.clearance.clear,
    subject: measure(best.clearance.subject),
    foreground: measure(best.clearance.foreground),
    centre: measure(best.clearance.centre),
    lens: measure(best.clearance.lens),
  };
  const place = b ? 'blast' : r.set.endsWith('crater') ? 'crater' : 'countryside',
    query = new URLSearchParams({
      place,
      era: b ? (b.mud ? '1944' : 'before') : eraOf(r),
      sky: b ? 'overcast' : skyOf(r.look),
      focus: `${Math.round(tx)},${Math.round(tz)}`,
      stop: String(optics.stop),
      focusDistance: String(optics.focusDistance),
      ...(b ? { blast: String(b.t), ...(b.mud ? { mud: '1' } : {}) } : {}),
      // The page draws plants 1,200 m round the camera and 12-triangle stand-ins beyond: a farther ground subject
      // widens it to 1.6 of the distance, the ground behind included (the scene's limit is 3,000 m).
      ...(!b && !drone && best.distance > 1000
        ? { radius: String(Math.min(3000, Math.round(1.6 * best.distance))) }
        : {}),
    }),
    people = r.source_tag.includes('PEOPLE') ? ` (fallback until people: ${r.fallback})` : '';
  const file = {
    format: 'margo-cutscene',
    version: 1,
    duration: dur,
    tracks: [
      {
        type: 'camera',
        id: 'camera',
        path: 'linear',
        keys: [
          { time: 0, position: round(pos0), target: round(tgt0), fov: Math.round(fov * 100) / 100 },
          {
            time: dur,
            position: round(pos1),
            target: round(tgt1),
            fov: Math.round(fov * 100) / 100,
            ease: 'smoothstep',
          },
        ],
      },
    ],
    shot: {
      format: 'margo-shot',
      version: 1,
      id: `fauld-${r.id}`,
      kind: 'long',
      // The catalogue scene (@margoengine/scenes), so validateShot and the shot's settings know it.
      scene: `fauld-${place}`,
      seconds: dur,
      about: `${r.id} ${r.section} (@margoengine/scenes/fauld-${place}): ${r.visual} | ${r.camera} | ${r.look}${people}`,
      // The shot tool adds the page's ground under the camera and the target (page.ground, docs/shots.md).
      page: {
        path: 'packages/scenes/test/fauld-still.html',
        query: Object.fromEntries(query),
        engine: 'fauldStill.engine',
        ground: 'fauldStill.height',
        ...(b ? { apply: 'fauldStill.apply' } : {}),
        canvas: 'canvas',
        ready: 'canvas',
      },
      warmup: 60,
      seed: 1944,
      size: [1920, 1080],
      fps: 24,
      shutter: 180,
      probes: { mid: Math.round(dur * 12) / 24 },
      // Heights are above the ground, like the camera's (`page.ground`).
      subject: { target: round([tx, tgtH, tz]), size },
    },
  };
  writeFileSync(`tools/shot/shots/fauld-${r.id}.json`, `${JSON.stringify(file, null, 2)}\n`);
  if (place === 'blast')
    blastGround[r.id] = file.tracks[0].keys.map((k) => [
      k.position[0],
      k.position[2],
      Math.round(groundUnder(k.position[0], k.position[2]) * 10) / 10,
    ]);
  n++;
}
writeFileSync('tools/shot/fauld-sight.json', `${JSON.stringify(sightReport, null, 1)}\n`);
writeFileSync('packages/scenes/test/fauld-blast-ground.json', `${JSON.stringify(blastGround)}\n`);
console.log(`${n} Fauld shot files written`);
