// Shot files for the Fauld crater and countryside rows of the recut shot list (channel-films Docs/fauld-shot-list-recut.csv):
//   node tools/shot/fauld-shots.mjs [--csv=<path>]   writes tools/shot/shots/fauld-frNNN.json, one per row
// Each row's camera text gives the lens (on the film pipeline's Super 35 filmback, 24.89 x 14 mm: the field of view is
// that of the 14 mm frame height, so the gates read back the same focal length), the height (drone N m, N m up),
// the distance (from N m, N km) and the move (dolly, push, pull back, orbit, pan, crane, rise, descend, track, slide,
// tilt); its visual names the subject (Hanbury, the works, the reservoir, the farm, the crater, the valley, the fields).
// Camera heights are above the ground under the camera and under the target: the shot tool adds the page's ground
// (`shot.page.ground`, fauldStill.height of packages/scenes/test/fauld-still.html).
// The place, era and sky go in the page query; `shot.subject` names the target and the subject's width. Places: FAULD_PLACES of @margoengine/scenes/fauld-world.
import { readFileSync, writeFileSync } from 'node:fs';

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
let n = 0;
for (const r of parse(csv)) {
  if (!/fauld-(crater|countryside)$/.test(r.set)) continue;
  const cam = r.camera.toLowerCase(),
    vis = r.visual.toLowerCase(),
    // A whole number of frames at 24 fps (the shot tool's rule).
    dur = Math.max(1, Math.round(Number(r.dur_s) * 24)) / 24,
    lens = inBand(Number(cam.match(/(\d+) mm/)?.[1] ?? (cam.includes('drone') ? 24 : 35))),
    fov = (2 * Math.atan(FILMBACK[1] / 2 / lens) * 180) / Math.PI,
    drone = cam.match(/drone (\d+)(?: to (\d+))? m/),
    up = cam.match(/(\d+(?:\.\d+)?) m (?:up|high)|, (\d+(?:\.\d+)?) m,/),
    km = `${vis} ${cam}`.match(/(\d+(?:\.\d+)?) km/),
    from = `${vis} ${cam}`.match(/(?:from|at) (?:the [a-z ]+ )?(\d+) m\b/),
    what = subject(r),
    [tx, tz] = PLACES[what],
    h0 = drone ? Number(drone[1]) : Number(up?.[1] ?? up?.[2] ?? 1.7),
    h1 = drone?.[2] ? Number(drone[2]) : h0;
  // Distance: named, else from the lens (a long lens stands far off), else from a drone's height.
  let dist = km
    ? Number(km[1]) * 1000
    : from
      ? Number(from[1])
      : drone
        ? Math.max(120, h0 * 1.4)
        : lens >= 135
          ? 450
          : lens >= 85
            ? 160
            : lens >= 50
              ? 60
              : 25;
  if (what === 'crater' && !drone && /rim|wood|memorial|stone|path|fence|birch|leaves/.test(vis))
    dist = Math.max(dist, 150);
  // Look from the south half (the low November sun behind or beside the camera), bearing by row.
  const bearing = Math.PI * (0.25 + 0.5 * hash(r.id)),
    ox = Math.cos(bearing) * dist,
    oz = Math.sin(bearing) * dist,
    pos0 = [tx + ox, h0, tz + oz],
    tgtH = drone ? 0 : what === 'crater' && /floor|up the|walls/.test(vis) ? 25 : 2,
    tgt0 = [tx, tgtH, tz];
  let pos1 = [...pos0],
    tgt1 = [...tgt0];
  const speed = Number(cam.match(/(\d+(?:\.\d+)?) m\/s/)?.[1] ?? 0.6),
    deg = Number(cam.match(/(\d+) deg/)?.[1] ?? 5) * (Math.PI / 180),
    fwd = [-ox / dist, -oz / dist],
    side = [-fwd[1], fwd[0]],
    travel = speed * dur;
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
  // The subject is what the frame holds of the place: never wider than the frame at the subject's distance (a shot from
  // among the fields frames a part of them, and a subject wider than the frame would put the camera inside it).
  const size = Math.min(SIZES[what], Math.round(dist * (FILMBACK[0] / lens))),
    optics = lensFor(lens, dist, size);
  const place = r.set.endsWith('crater') ? 'crater' : 'countryside',
    query = new URLSearchParams({
      place,
      era: eraOf(r),
      sky: skyOf(r.look),
      focus: `${Math.round(tx)},${Math.round(tz)}`,
      stop: String(optics.stop),
      focusDistance: String(optics.focusDistance),
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
  n++;
}
console.log(`${n} Fauld shot files written`);
