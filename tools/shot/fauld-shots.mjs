// Shot files for the Fauld crater and countryside rows of the recut shot list (channel-films Docs/fauld-shot-list-recut.csv):
//   node tools/shot/fauld-shots.mjs [--csv=<path>]   writes tools/shot/shots/fauld-frNNN.json, one per row
// Each row's camera text gives the lens (vertical field of view of a 24 mm high frame), the height (drone N m, N m up),
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
// How wide each subject is, metres (the film pipeline's framing and focus checks read `shot.subject`).
const SIZES = { crater: 230, farm: 60, hanbury: 400, church: 30, inn: 20, works: 200, reservoir: 300, dove: 300, fields: 400 };
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
    lens = Number(cam.match(/(\d+) mm/)?.[1] ?? (cam.includes('drone') ? 24 : 35)),
    fov = (2 * Math.atan(12 / lens) * 180) / Math.PI,
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
  const place = r.set.endsWith('crater') ? 'crater' : 'countryside',
    query = new URLSearchParams({
      place,
      era: eraOf(r),
      sky: skyOf(r.look),
      focus: `${Math.round(tx)},${Math.round(tz)}`,
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
      subject: { target: round(tgt0), size: SIZES[what] },
    },
  };
  writeFileSync(`tools/shot/shots/fauld-${r.id}.json`, `${JSON.stringify(file, null, 2)}\n`);
  n++;
}
console.log(`${n} Fauld shot files written`);
