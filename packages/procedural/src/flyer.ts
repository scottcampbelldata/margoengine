import { boxGeometry, cylinderGeometry } from '@margoengine/geometry/primitives';
import { mergeGeometries, applyMatrix4, geometryData, type GeometryData } from '@margoengine/geometry/utils';

/*
 * The 1903 Wright Flyer as geometry, and its four flights of 17 December 1903 as a pose at time t.
 *
 * Sources (dimensions and figures only; no model, drawing file or code of anyone else was used):
 * - National Air and Space Museum, 1903 Wright Flyer, object A19610048000: wingspan 12.3 m (40 ft 4 in), length
 *   6.4 m (21 ft 1 in), height 2.8 m (9 ft 3 in), weight 274 kg (605 lb), 12 hp engine, two pusher propellers.
 *   https://airandspace.si.edu/collection-objects/1903-wright-flyer/nasm_A19610048000
 * - National Park Service, Wright Brothers National Memorial, "1903: The First Flight": the 27 mph wind, the 60 ft
 *   rail, 120 ft in 12 s, 852 ft in 59 s, groundspeed 6.8 mph and airspeed 34 mph of the first flight.
 *   https://www.nps.gov/wrbr/learn/historyculture/thefirstflight.htm
 * - Jakab, P. L. 1990. Visions of a Flying Machine: The Wright Brothers and the Process of Invention. Smithsonian
 *   Institution Press: chord 6 ft 6 in, gap 6 ft 2 in, camber 1 in 20, the 10 in droop of the wing tips, propellers
 *   8 ft 6 in across turning in opposite directions at about 350 rpm, the biplane elevator ahead and twin rudders.
 * - McFarland, M. W. (ed.) 1953. The Papers of Wilbur and Orville Wright. McGraw-Hill: Orville's diary for
 *   17 December 1903 (the run of about 40 ft on the rail, the second flight of 175 ft, the third of 200 ft in 15 s,
 *   the up and down course of the first flight).
 * - Hobbs, L. S. 1971. The Wright Brothers' Engines and Their Design. Smithsonian Annals of Flight 5, Smithsonian
 *   Institution Press: the 1903 engine's four horizontal water-cooled cylinders of 4 in bore pointing forward, the
 *   cast aluminium crankcase, the crankshaft across the span with flywheel and chain sprocket on its ends, and the
 *   upright flat-tube radiator and small fuel tank beside it.
 */

const FT = 0.3048;

/** Options of {@link generateWrightFlyer}; every length in metres. */
export interface WrightFlyerOptions {
  /** Wingspan. Default 12.29 (40 ft 4 in). */
  span?: number;
  /** Wing chord. Default 1.98 (6 ft 6 in). */
  chord?: number;
  /** Gap between the wings. Default 1.88 (6 ft 2 in). */
  gap?: number;
  /** Camber of the wing as a share of the chord. Default 0.05 (1 in 20). */
  camber?: number;
  /** How far the wing tips sit below the centre. Default 0.254 (10 in). */
  droop?: number;
  /** Propeller diameter. Default 2.59 (8 ft 6 in). */
  propeller?: number;
  /** Spanwise segments of each wing (8 to 128). Default 48. */
  segments?: number;
  /**
   * The Flyer as the gust of 17 December 1903 left it after the fourth flight: ribs broken out of the right wings,
   * the right wing panels crushed down and twisted, uprights snapped, a propeller broken and the engine knocked
   * askew on its bed with its chain guide tubes. Default false (the Flyer as flown).
   */
  wrecked?: boolean;
  /** Seed of the wreck's broken ribs and crumpling. Default 1903. */
  seed?: number;
}

/** A part that turns about its own pivot: transform the geometry by a rotation about `axis` through `pivot`. */
export interface FlyerMovingPart {
  geometry: GeometryData;
  /** Pivot in the Flyer's own space. */
  pivot: [number, number, number];
  /** Unit axis the part turns about. */
  axis: [number, number, number];
}

/** A propeller: a moving part plus the way it turns, +1 or -1 about its axis. */
export interface FlyerPropeller extends FlyerMovingPart {
  spin: 1 | -1;
}

/**
 * The Flyer in its own space (glTF's right-handed axes): +Z forward (the elevator end), +Y up, so +X is to the prone
 * pilot's left and -X to his right (forward x up = -X); the skids' lowest point
 * is at y = 0 and the wing centre at x = 0, z = 0.
 */
export interface WrightFlyerMesh {
  /** Fabric: both wings, double covered, cambered and drooped. Unbleached muslin. */
  wings: GeometryData;
  /** Wood: spars' edges, struts, skids, outriggers, propeller supports. Spruce and ash. */
  frame: GeometryData;
  /** The engine, radiator and chain tubes: dark metal. */
  engine: GeometryData;
  /** The ribs showing through the fabric, about a foot apart on both wings and the elevator: wood. */
  ribs: GeometryData;
  /** Bracing wires crossing every bay of the front and rear trusses and the chains to the propellers: steel. */
  wires: GeometryData;
  /** The pilot's hip cradle on the lower wing: wood. */
  cradle: GeometryData;
  /** Biplane elevator ahead (fabric and its ribs); turns about +X for pitch control. */
  elevator: FlyerMovingPart;
  /** Twin rudders behind; turn about +Y. */
  rudder: FlyerMovingPart;
  /**
   * The elevator hand lever at the pilot's left hand, ahead of the hip cradle: wood. It turns about +X through its
   * foot; turn it by the elevator's angle so the hand and the elevator move together.
   */
  lever: FlyerMovingPart;
  /**
   * Where the restraining wire was hooked at the rear of the skids: it held the Flyer against the propellers' pull
   * until the pilot let it go. Draw the wire with {@link restrainingWire}.
   */
  restraint: { tie: [number, number, number] };
  /**
   * Left (+X) and right (-X) pushers. Each spins about +Z by `spin`: the left -1 (anticlockwise seen from behind), the
   * right +1 (clockwise seen from behind), opposite ways as built; each one's blades are pitched to push the Flyer
   * forward when turning its own way.
   */
  propellers: [FlyerPropeller, FlyerPropeller];
  /** Where a prone pilot lies: hips, head end, and the lower wing's top height there. */
  pilot: { hips: [number, number, number]; head: [number, number, number] };
  /** Overall size: width, height, length. */
  size: [number, number, number];
}

function positive(name: string, v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v) || v < lo || v > hi) throw new RangeError(`generateWrightFlyer: ${name} ${v} is outside ${lo} to ${hi}; pass a value in that range`);
  return v;
}

type V3 = [number, number, number];

/** A box of cross-section w x h along the segment a to b (the box's local Y runs along the segment). */
function beam(a: V3, b: V3, w: number, h: number): GeometryData {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const d: V3 = [dx / len, dy / len, dz / len];
  // A helper not parallel to d, then u = helper x d, v = d x u.
  const helper: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: V3 = [helper[1] * d[2] - helper[2] * d[1], helper[2] * d[0] - helper[0] * d[2], helper[0] * d[1] - helper[1] * d[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const m = [
    u[0] * w, u[1] * w, u[2] * w, 0,
    d[0] * len, d[1] * len, d[2] * len, 0,
    v[0] * h, v[1] * h, v[2] * h, 0,
    (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 1,
  ];
  return applyMatrix4(boxGeometry(1, 1, 1), m);
}

function box(cx: number, cy: number, cz: number, w: number, h: number, d: number): GeometryData {
  return applyMatrix4(boxGeometry(w, h, d), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, cy, cz, 1]);
}

/**
 * A cambered, double-covered surface: `span` across X centred on x0, chord along Z from zLead to zLead - chord, the
 * camber line peaking at 30 % of the chord, the thickness that of the spars at the front and rear and thinning to the
 * edges, the tips `droop` below the centre (linear in |x|, as the 1903 wings were rigged).
 */
function cambered(
  span: number,
  chord: number,
  y0: number,
  zLead: number,
  camber: number,
  droop: number,
  thick: number,
  segs: number,
): GeometryData {
  const C = 14;
  const pos: number[] = [],
    nor: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  const camberAt = (s: number) => {
    // Two parabolas meeting at s = 0.3 with a zero slope: the peak forward of the middle, as on the Wright ribs.
    const p = 0.3;
    return s < p ? camber * chord * (1 - ((p - s) / p) ** 2) : camber * chord * (1 - ((s - p) / (1 - p)) ** 2);
  };
  const halfThick = (s: number) => 0.5 * thick * Math.sin(Math.PI * Math.min(1, Math.max(0, s))) ** 0.5;
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const x = -span / 2 + (span * i) / segs;
      const yd = -droop * (Math.abs(x) / (span / 2));
      for (let j = 0; j <= C; j++) {
        const s = j / C;
        const yc = camberAt(s) + yd + y0;
        const y = yc + side * halfThick(s);
        const z = zLead - s * chord;
        pos.push(x, y, z);
        // Normal of the camber line (slope dy/dz) tilted by the droop's slope across the span.
        const ds = 1e-3;
        const slope = (camberAt(Math.min(1, s + ds)) - camberAt(Math.max(0, s - ds))) / (2 * ds * chord);
        const sx = (droop / (span / 2)) * Math.sign(x);
        let nx = side * sx,
          ny = side * 1,
          nz = side * slope;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        nor.push(nx, ny, nz);
        uv.push(x / chord, s);
      }
    }
    for (let i = 0; i < segs; i++)
      for (let j = 0; j < C; j++) {
        const a = base + i * (C + 1) + j,
          b = a + C + 1;
        if (side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1);
        else idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
  }
  return geometryData(pos, nor, uv, idx);
}

/** A twisted propeller blade pair about +Z through the origin: blade length r each way, chord tapering to the tip. */
function propellerBlades(radius: number): GeometryData {
  const parts: GeometryData[] = [];
  const N = 10;
  for (const dir of [1, -1]) {
    for (let i = 0; i < N; i++) {
      const r0 = 0.12 + ((radius - 0.12) * i) / N,
        r1 = 0.12 + ((radius - 0.12) * (i + 1)) / N;
      const rm = (r0 + r1) / 2;
      const chord = 0.2 * Math.sin(Math.PI * (0.25 + (0.65 * rm) / radius));
      // Pitch angle falls from about 30 degrees near the hub to about 10 at the tip (a constant pitch helix).
      const twist = Math.atan(0.9 / (2 * Math.PI * rm));
      const piece = boxGeometry(r1 - r0 + 0.002, chord, 0.025);
      const c = Math.cos(twist),
        s = Math.sin(twist);
      // Rotate about the blade's own X (its length) by the twist, then place it along +X or -X.
      const m = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, dir * rm, 0, 0, 1];
      parts.push(applyMatrix4(piece, dir > 0 ? m : [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, dir * rm, 0, 0, 1]));
    }
  }
  parts.push(applyMatrix4(cylinderGeometry(0.07, 0.07, 0.16, 12), [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]));
  return mergeGeometries(parts);
}

/**
 * Builds the 1903 Wright Flyer from its published dimensions: double-covered cambered wings with drooped tips, the
 * struts between them, two skids running forward to the biplane elevator, twin rudders behind, the engine right of
 * centre with its chain tubes, the pilot's hip cradle left of centre, and two pusher propellers on their own pivots.
 * Every part is separate so a scene can give fabric, wood and metal their own materials and turn the moving parts.
 */
export function generateWrightFlyer(options: WrightFlyerOptions = {}): WrightFlyerMesh {
  const span = positive('span', options.span ?? 40 * FT + 4 * 0.0254, 4, 30);
  const chord = positive('chord', options.chord ?? 6.5 * FT, 0.5, 5);
  const gap = positive('gap', options.gap ?? (6 + 2 / 12) * FT, 0.5, 5);
  const camber = positive('camber', options.camber ?? 0.05, 0, 0.15);
  const droop = positive('droop', options.droop ?? 10 * 0.0254, 0, 1);
  const prop = positive('propeller', options.propeller ?? 8.5 * FT, 0.5, 5);
  const segs = Math.round(positive('segments', options.segments ?? 48, 8, 128));

  const yLow = 0.62; // lower wing's chord line above the skid bottom
  const yUp = yLow + gap;
  const lead = chord / 2;
  const thick = 0.045;
  const wings = mergeGeometries([
    cambered(span, chord, yLow, lead, camber, droop, thick, segs),
    cambered(span, chord, yUp, lead, camber, droop, thick, segs),
  ]);

  const frame: GeometryData[] = [];
  const spanStations: number[] = [];
  // Uprights: a pair at each side of the centre section and five more pairs out to each tip.
  const half = span / 2;
  const centre = 0.45;
  for (let k = 0; k <= 5; k++) spanStations.push(centre + ((half - 0.12 - centre) * k) / 5);
  const frontZ = lead - 0.12,
    rearZ = lead - chord + 0.12;
  const camberY = (z: number) => {
    const s = (lead - z) / chord;
    const p = 0.3;
    return s < p ? camber * chord * (1 - ((p - s) / p) ** 2) : camber * chord * (1 - ((s - p) / (1 - p)) ** 2);
  };
  for (const sx of [1, -1])
    for (const x0 of spanStations) {
      const x = sx * x0;
      const yd = -droop * (x0 / half);
      for (const z of [frontZ, rearZ]) {
        const yc = camberY(z) + yd;
        frame.push(beam([x, yLow + yc, z], [x, yUp + yc, z], 0.028, 0.05));
      }
    }
  // Leading and trailing edge strips of both wings, in straight pieces between the stations so they follow the droop.
  for (const y0 of [yLow, yUp])
    for (const sx of [1, -1]) {
      const xs = [0, ...spanStations, half];
      for (let i = 0; i < xs.length - 1; i++) {
        const xa = sx * xs[i],
          xb = sx * xs[i + 1];
        const ya = y0 - droop * (xs[i] / half),
          yb = y0 - droop * (xs[i + 1] / half);
        frame.push(beam([xa, ya + 0.004, lead], [xb, yb + 0.004, lead], 0.03, 0.03));
        frame.push(beam([xa, ya + camberY(lead - chord + 0.01), lead - chord + 0.01], [xb, yb + camberY(lead - chord + 0.01), lead - chord + 0.01], 0.012, 0.012));
      }
    }
  // Skids: two runners under the centre, from behind the rear spar forward and up to the elevator.
  const elevZ = 3.0,
    elevY = 1.25,
    elevGap = 0.9,
    elevSpan = 12 * FT,
    elevChord = 2.5 * FT;
  for (const sx of [0.38, -0.38]) {
    frame.push(beam([sx, 0.04, rearZ - 0.3], [sx, 0.04, 1.6], 0.05, 0.08));
    frame.push(beam([sx, 0.04, 1.6], [sx, elevY - elevGap / 2, elevZ - 0.2], 0.05, 0.07));
    // Uprights from the skid to the lower wing.
    frame.push(beam([sx, 0.04, frontZ], [sx, yLow + camberY(frontZ), frontZ], 0.04, 0.04));
    frame.push(beam([sx, 0.04, rearZ], [sx, yLow + camberY(rearZ), rearZ], 0.04, 0.04));
    // Outriggers from the upper wing's leading edge to the elevator.
    frame.push(beam([sx, yUp + camberY(frontZ), frontZ], [sx, elevY + elevGap / 2, elevZ - 0.2], 0.035, 0.035));
    frame.push(beam([sx, yLow + camberY(frontZ), frontZ], [sx, elevY - elevGap / 2, elevZ - 0.2], 0.035, 0.035));
  }
  // Rudder outriggers.
  const rudZ = -2.75,
    rudH = 6 * FT,
    rudChord = 0.6,
    rudY = 0.5;
  for (const sx of [0.35, -0.35]) {
    frame.push(beam([sx, yLow + camberY(rearZ), rearZ], [sx * 0.9, rudY, rudZ + rudChord / 2], 0.03, 0.03));
    frame.push(beam([sx, yUp + camberY(rearZ), rearZ], [sx * 0.9, rudY + rudH, rudZ + rudChord / 2], 0.03, 0.03));
  }
  // Propeller supports: a strut from the lower to the upper rear spar behind each shaft.
  const propX = 1.68,
    propY = yLow + gap / 2 + 0.05,
    propZ = lead - chord - 0.45;
  for (const sx of [propX, -propX]) {
    frame.push(beam([sx, yLow + camberY(rearZ) - 0.02, rearZ], [sx, propY, propZ + 0.1], 0.04, 0.04));
    frame.push(beam([sx, yUp + camberY(rearZ) - 0.02, rearZ], [sx, propY, propZ + 0.1], 0.04, 0.04));
  }

  // Engine right of centre on the lower wing (Hobbs 1971): an in-line four, its four water-jacketed cylinders (4 in
  // bore) lying flat and pointing forward from the crankcase, the crankshaft across the span with the flywheel on its
  // outer end and the chain sprocket on its inner end; the flat-tube radiator upright on a strut beside it, the fuel
  // tank hung from a front strut; chain tubes to the propeller shafts.
  // The pilot faces +Z with +Y up, so his right is -X: the engine sits at -X, the cradle and the pilot at +X.
  const right = -1,
    ex = right * 0.42,
    ey = yLow + 0.2,
    ez = -0.05,
    xAxis = (r: number, len: number, x: number, y: number, z: number, seg = 16) =>
      applyMatrix4(cylinderGeometry(r, r, len, seg), [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, x, y, z, 1]),
    zAxis = (r: number, len: number, x: number, y: number, z: number, seg = 12) =>
      applyMatrix4(cylinderGeometry(r, r, len, seg), [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, y, z, 1]);
  const engineParts: GeometryData[] = [
    box(ex, ey, ez - 0.1, 0.5, 0.24, 0.22), // crankcase
    box(ex, ey - 0.15, ez - 0.1, 0.42, 0.06, 0.18), // sump
    box(ex, ey + 0.06, ez + 0.36, 0.5, 0.06, 0.06), // intake manifold over the heads
    box(ex - right * 0.3, ey + 0.1, ez + 0.2, 0.08, 0.08, 0.1), // carburettor (fuel chamber)
    xAxis(0.17, 0.035, ex + right * 0.3, ey, ez - 0.1, 24), // flywheel, on the outer end
    xAxis(0.05, 0.05, ex + right * 0.3, ey, ez - 0.1, 12), // flywheel hub
    xAxis(0.06, 0.02, ex - right * 0.28, ey, ez - 0.1, 16), // chain sprocket, on the inner end
  ];
  for (let i = 0; i < 4; i++) {
    const cx = ex - 0.18 + i * 0.12;
    engineParts.push(zAxis(0.058, 0.32, cx, ey, ez + 0.17)); // water jacket
    engineParts.push(zAxis(0.03, 0.04, cx, ey, ez + 0.35, 8)); // head plug
  }
  // Radiator: eleven flat vertical tubes between a top and a bottom header.
  for (let i = 0; i < 11; i++) engineParts.push(box(right * 0.05, yLow + 0.55, 0.15 - 0.19 + i * 0.038, 0.06, 0.82, 0.012));
  engineParts.push(box(right * 0.05, yLow + 0.98, 0.15, 0.08, 0.05, 0.44), box(right * 0.05, yLow + 0.12, 0.15, 0.08, 0.05, 0.44));
  engineParts.push(zAxis(0.055, 0.28, right * 0.05, yUp - 0.12, 0.55, 14)); // fuel tank under the upper wing
  const engine = mergeGeometries([
    ...engineParts,
    beam([ex, yLow + 0.3, -0.35], [propX, propY, propZ + 0.05], 0.05, 0.05),
    beam([ex, yLow + 0.3, -0.35], [-propX, propY, propZ + 0.05], 0.05, 0.05),
    applyMatrix4(cylinderGeometry(0.03, 0.03, 0.5, 8), [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, propX, propY, propZ + 0.25, 1]),
    applyMatrix4(cylinderGeometry(0.03, 0.03, 0.5, 8), [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, -propX, propY, propZ + 0.25, 1]),
  ]);

  // Ribs: a cambered strip over and under each wing every 0.31 m (about a foot), the fabric's pockets showing them.
  const ribs: GeometryData[] = [];
  const nRibs = Math.round(span / 0.31);
  for (const y0 of [yLow, yUp])
    for (let r = 0; r <= nRibs; r++) {
      const x = -half + 0.05 + ((span - 0.1) * r) / nRibs;
      const yd = -droop * (Math.abs(x) / half);
      const pts: V3[] = [];
      for (let j = 0; j <= 8; j++) {
        const z = lead - (chord * j) / 8;
        pts.push([x, y0 + yd + camberY(z), z]);
      }
      for (const side of [1, -1])
        for (let j = 0; j < 8; j++) {
          const lift = (s: number) => side * (0.5 * thick * Math.sin(Math.PI * s) ** 0.5 + 0.004);
          const a = pts[j],
            b = pts[j + 1];
          ribs.push(beam([a[0], a[1] + lift(j / 8), a[2]], [b[0], b[1] + lift((j + 1) / 8), b[2]], 0.012, 0.008));
        }
    }
  // Wires: an X in every bay between neighbouring uprights, in the front and the rear truss.
  const wires: GeometryData[] = [];
  const wire = (a: V3, b: V3) => wires.push(beam(a, b, 0.006, 0.006));
  const stations = [-1, 1].flatMap((sx) => spanStations.map((x0) => sx * x0)).sort((a, b) => a - b);
  for (const z of [frontZ, rearZ])
    for (let i = 0; i < stations.length - 1; i++) {
      const xa = stations[i],
        xb = stations[i + 1];
      const ya = -droop * (Math.abs(xa) / half) + camberY(z),
        yb = -droop * (Math.abs(xb) / half) + camberY(z);
      wire([xa, yLow + ya, z], [xb, yUp + yb, z]);
      wire([xa, yUp + ya, z], [xb, yLow + yb, z]);
    }
  // Diagonals from front to rear spar in the outer bays, and the elevator's and rudders' bracing.
  for (const sx of [1, -1]) {
    const x0 = sx * spanStations[1],
      x1 = sx * spanStations[2];
    wire([x0, yLow + camberY(frontZ), frontZ], [x1, yLow + camberY(rearZ), rearZ]);
    wire([x0, yUp + camberY(frontZ), frontZ], [x1, yUp + camberY(rearZ), rearZ]);
  }
  // The chains: an upper and a lower run from the engine sprocket to each propeller sprocket.
  const sprocket: V3 = [ex, yLow + 0.3, -0.3];
  for (const sx of [propX, -propX]) {
    for (const dy of [0.07, -0.07]) wire([sprocket[0], sprocket[1] + dy, sprocket[2]], [sx, propY + dy, propZ + 0.12]);
    wires.push(applyMatrix4(cylinderGeometry(0.08, 0.08, 0.02, 16), [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, sx, propY, propZ + 0.12, 1]));
  }
  const px = -right * 0.45; // the pilot and his hip cradle, left of centre
  const cradle = mergeGeometries([box(px, yLow + 0.12, -0.15, 0.36, 0.06, 0.5), beam([px, yLow + 0.1, 0.1], [px, yLow + 0.1, 0.9], 0.04, 0.04)]);

  const elevator = {
    geometry: mergeGeometries([
      cambered(elevSpan, elevChord, elevY - elevGap / 2, elevZ + elevChord / 2, 0.05, 0, 0.03, 16),
      cambered(elevSpan, elevChord, elevY + elevGap / 2, elevZ + elevChord / 2, 0.05, 0, 0.03, 16),
      beam([-elevSpan / 2 + 0.05, elevY - elevGap / 2, elevZ], [-elevSpan / 2 + 0.05, elevY + elevGap / 2, elevZ], 0.025, 0.025),
      beam([elevSpan / 2 - 0.05, elevY - elevGap / 2, elevZ], [elevSpan / 2 - 0.05, elevY + elevGap / 2, elevZ], 0.025, 0.025),
      beam([-0.6, elevY - elevGap / 2, elevZ], [-0.6, elevY + elevGap / 2, elevZ], 0.025, 0.025),
      beam([0.6, elevY - elevGap / 2, elevZ], [0.6, elevY + elevGap / 2, elevZ], 0.025, 0.025),
    ]),
    pivot: [0, elevY, elevZ] as V3,
    axis: [1, 0, 0] as V3,
  };
  const rudPlanes: GeometryData[] = [];
  for (const sx of [0.3, -0.3]) {
    rudPlanes.push(box(sx, rudY + rudH / 2, rudZ, 0.03, rudH, rudChord));
    rudPlanes.push(beam([sx, rudY, rudZ + rudChord / 2], [sx, rudY + rudH, rudZ + rudChord / 2], 0.035, 0.035));
  }
  rudPlanes.push(beam([0.3, rudY + 0.05, rudZ], [-0.3, rudY + 0.05, rudZ], 0.03, 0.03));
  rudPlanes.push(beam([0.3, rudY + rudH - 0.05, rudZ], [-0.3, rudY + rudH - 0.05, rudZ], 0.03, 0.03));
  const rudder = { geometry: mergeGeometries(rudPlanes), pivot: [0, rudY + rudH / 2, rudZ + rudChord / 2] as V3, axis: [0, 1, 0] as V3 };

  // The elevator lever: an upright stick at the pilot's left hand ahead of the cradle, its foot on a block on the lower
  // wing, a short cross grip at the top (Jakab 1990: the pilot worked the elevator with his left hand).
  const leverFoot: V3 = [px + 0.3, yLow + 0.06, 0.95],
    leverH = 0.42;
  const lever = {
    geometry: mergeGeometries([
      beam(leverFoot, [leverFoot[0], leverFoot[1] + leverH, leverFoot[2]], 0.03, 0.03),
      beam([leverFoot[0] - 0.05, leverFoot[1] + leverH, leverFoot[2]], [leverFoot[0] + 0.05, leverFoot[1] + leverH, leverFoot[2]], 0.035, 0.035),
      box(leverFoot[0], leverFoot[1] - 0.01, leverFoot[2], 0.12, 0.03, 0.08),
    ]),
    pivot: [leverFoot[0], leverFoot[1], leverFoot[2]] as V3,
    axis: [1, 0, 0] as V3,
  };
  const restraint = { tie: [0, 0.08, rearZ - 0.3] as V3 };

  const blades = propellerBlades(prop / 2);
  // The blades are pitched to drive the air toward -Z (thrust toward +Z) when turning +1 about +Z; the -1 propeller gets their
  // mirror image, as the Wrights carved a left-hand and a right-hand pair.
  const placeProp = (x: number, spin: 1 | -1) => applyMatrix4(blades, [spin, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, propY, propZ, 1]);
  const propellers: [FlyerPropeller, FlyerPropeller] = [
    { geometry: placeProp(-right * propX, -1), pivot: [-right * propX, propY, propZ], axis: [0, 0, 1], spin: -1 },
    { geometry: placeProp(right * propX, 1), pivot: [right * propX, propY, propZ], axis: [0, 0, 1], spin: 1 },
  ];

  const wreck = options.wrecked === true ? wrecker(half, yLow, options.seed ?? 1903) : null;
  if (wreck) {
    // About a third of the right wings' ribs broken out; some outer uprights snapped.
    const kept = ribs.filter((g) => !(g.positions[0] < -1.2 && wreck.rand() < 0.35));
    ribs.length = 0;
    ribs.push(...kept);
    for (let i = 0; i < frame.length; i++) if (frame[i].positions[0] < -2.5 && wreck.rand() < 0.3) frame[i] = applyMatrix4(frame[i], wreck.snap(frame[i]));
  }
  const out: WrightFlyerMesh = {
    wings,
    ribs: mergeGeometries(ribs),
    wires: mergeGeometries(wires),
    frame: mergeGeometries(frame),
    engine,
    cradle,
    elevator,
    rudder,
    lever,
    restraint,
    propellers,
    pilot: { hips: [px, yLow + 0.1, -0.2], head: [px, yLow + 0.18, 1.1] },
    size: [span, rudY + rudH + 0.1 > yUp + 0.2 ? rudY + rudH + 0.1 : yUp + 0.2, elevZ + elevChord / 2 - (rudZ - rudChord / 2)],
  };
  if (wreck) {
    out.wings = wreck.crush(out.wings);
    out.ribs = wreck.crush(out.ribs);
    out.wires = wreck.crush(out.wires);
    out.frame = wreck.crush(out.frame);
    // The engine knocked askew: tipped 14 degrees about the span through its bed and slid back 8 cm, which bends the
    // chain guide tubes that run from it to the propeller shafts.
    const c = Math.cos(0.24),
      s = Math.sin(0.24);
    out.engine = applyMatrix4(engine, [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, yLow - c * yLow + s * ez, ez - s * yLow - c * ez - 0.08, 1]);
    const right = out.propellers[1];
    out.propellers = [out.propellers[0], { ...right, geometry: applyMatrix4(right.geometry, wreck.snap(right.geometry)) }];
  }
  return out;
}

/** The wreck's seeded generator (mulberry32) and its deformations. */
function wrecker(half: number, yLow: number, seed: number) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const k = 0.6 + 0.3 * rand();
  return {
    rand,
    /** Crushes the right (-X) wings: the outer panels pushed down toward the sand, swept back and rippled where they folded. */
    crush(g: GeometryData): GeometryData {
      const p = Float32Array.from(g.positions);
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i];
        if (x >= -1.2) continue;
        const u = Math.min(1, (-x - 1.2) / (half - 1.2)),
          fold = u * u,
          above = Math.max(0, p[i + 1] - yLow);
        p[i + 1] = Math.max(0.03, p[i + 1] - fold * (0.55 * above + 0.35 * k) + 0.04 * u * Math.sin(x * 7.3 + p[i + 2] * 3.1));
        p[i + 2] += 0.35 * fold * k + 0.08 * u * Math.sin(p[i + 1] * 5);
      }
      return geometryData(p, g.normals, g.uvs, g.indices);
    },
    /** A snapped member: turned 0.3 to 0.7 radians about Z through its lowest point (column-major matrix). */
    snap(g: GeometryData): number[] {
      let lo = 0;
      for (let i = 0; i < g.positions.length; i += 3) if (g.positions[i + 1] < g.positions[lo + 1]) lo = i;
      const x0 = g.positions[lo],
        y0 = g.positions[lo + 1],
        t = 0.3 + 0.4 * rand(),
        c = Math.cos(t),
        s = Math.sin(t);
      return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x0 - c * x0 + s * y0, y0 - s * x0 - c * y0, 0, 1];
    },
  };
}

/**
 * The restraining wire from a tie point to a stake in the sand, as a sagging run of short steel segments. `tie` and
 * `stake` are in one space (put {@link WrightFlyerMesh.restraint}'s tie through the Flyer's transform first). `slack`
 * 0 pulls it taut (held before release); 1 lets it hang loose, sagging an eighth of its length at the middle (let go),
 * lying on the sand where it would go below `ground` (the sand's height there; default no floor).
 */
export function restrainingWire(tie: readonly number[], stake: readonly number[], slack = 0, ground = -Infinity, segments = 16): GeometryData {
  if (tie.length !== 3 || stake.length !== 3 || ![...tie, ...stake, slack].every(Number.isFinite) || Number.isNaN(ground) || !(segments >= 1))
    throw new RangeError('restrainingWire: pass tie and stake as finite [x, y, z], a finite slack, a ground height and 1 or more segments');
  const sl = Math.min(1, Math.max(0, slack)),
    len = Math.hypot(stake[0] - tie[0], stake[1] - tie[1], stake[2] - tie[2]),
    floor = ground + 0.003,
    n = Math.round(segments);
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const y = tie[1] + (stake[1] - tie[1]) * u - sl * 0.125 * len * 4 * u * (1 - u);
    pts.push([tie[0] + (stake[0] - tie[0]) * u, Math.max(floor, y), tie[2] + (stake[2] - tie[2]) * u]);
  }
  const parts: GeometryData[] = [];
  for (let i = 0; i < n; i++)
    if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]) > 1e-6) parts.push(beam(pts[i], pts[i + 1], 0.006, 0.006));
  return mergeGeometries(parts);
}

/** The Flyer's pose at time t of the gust that rolled it over after the fourth flight. */
export interface WrightGustRollPose {
  /** Position of the Flyer's origin: x sideways (the roll carries it toward -X), y up, z along its heading. */
  position: [number, number, number];
  /** Nose up, radians. */
  pitch: number;
  /** Roll about the Flyer's length, radians, in the sense of {@link WrightFlightPose.roll}; 2 pi is one turn over. */
  roll: number;
  /** Turn about the vertical, radians. */
  yaw: number;
  phase: 'standing' | 'rolling' | 'rest';
  /** Seconds from the gust's arrival to rest. */
  duration: number;
}

/** Options of {@link wrightGustRoll}. */
export interface WrightGustRollOptions {
  /** Full turns over before it comes to rest, above 0 to 4. Default 1. */
  turns?: number;
  /** Seconds of the turning over. Default 4. */
  seconds?: number;
  /** Seconds the gust takes to lift the left wing before it goes over. Default 1.2. */
  lift?: number;
  /** Wingspan, metres (it rolls on its tips, half of it from the centre). Default 12.29. */
  span?: number;
}

/**
 * The gust after the fourth flight (Orville's diary, McFarland 1953): a gust lifted the standing Flyer's left wing and
 * turned it over and over across the sand, Daniels caught inside. t = 0 is the gust's arrival: the left wing lifts for
 * `lift` seconds, then the Flyer turns over its right tip like a wheel on its wing tips (the centre at half the span
 * times |sin roll| above the sand), fast at first and slowing to rest after `turns` turns, drifting downwind (-Z,
 * behind it) and slewing a little. Draw the wrecked Flyer ({@link WrightFlyerOptions.wrecked}) once it rests.
 */
export function wrightGustRoll(t: number, options: WrightGustRollOptions = {}): WrightGustRollPose {
  if (!Number.isFinite(t)) throw new RangeError('wrightGustRoll: t is not finite; pass seconds after the gust as a finite number');
  const turns = options.turns ?? 1,
    seconds = options.seconds ?? 4,
    lift = options.lift ?? 1.2,
    half = (options.span ?? 40 * FT + 4 * 0.0254) / 2;
  if (!(turns > 0 && turns <= 4 && seconds > 0 && lift >= 0 && half > 0))
    throw new RangeError('wrightGustRoll: pass turns above 0 to 4, seconds above 0, lift 0 or more and a positive span');
  const duration = lift + seconds,
    tip = 0.35;
  let roll = 0,
    phase: WrightGustRollPose['phase'] = 'standing';
  if (t > 0 && t < lift) {
    const u = t / lift;
    roll = -tip * u * u * (3 - 2 * u);
    phase = 'rolling';
  } else if (t >= lift && t < duration) {
    const u = (t - lift) / seconds;
    roll = -tip - (2 * Math.PI * turns - tip) * (1 - (1 - u) ** 2);
    phase = 'rolling';
  } else if (t >= duration) {
    roll = -2 * Math.PI * turns;
    phase = 'rest';
  }
  const along = Math.min(1, Math.max(0, t / duration));
  return {
    position: [(roll * half) / Math.PI + 0, Math.max(0, (half - 0.35) * Math.abs(Math.sin(roll))), along > 0 ? -2.5 * along : 0],
    pitch: 0.12 * Math.sin(-roll),
    roll,
    yaw: 0.3 * along,
    phase,
    duration,
  };
}

/** One of the four flights of 17 December 1903 (Orville's diary, McFarland 1953; NPS). */
export interface WrightFlight {
  n: 1 | 2 | 3 | 4;
  pilot: 'Orville' | 'Wilbur';
  /** Distance over the ground from the rail, metres. */
  distance: number;
  /** Seconds in the air. */
  seconds: number;
  /** Highest height of the skids above the sand, metres. */
  height: number;
}

/** The four flights: 120 ft in 12 s, 175 ft, 200 ft in 15 s, 852 ft in 59 s. */
export const WRIGHT_FLIGHTS_1903: readonly WrightFlight[] = Object.freeze([
  { n: 1, pilot: 'Orville', distance: 120 * FT, seconds: 12, height: 3 },
  { n: 2, pilot: 'Wilbur', distance: 175 * FT, seconds: 12, height: 3 },
  { n: 3, pilot: 'Orville', distance: 200 * FT, seconds: 15, height: 3 },
  { n: 4, pilot: 'Wilbur', distance: 852 * FT, seconds: 59, height: 4 },
] as WrightFlight[]);

/** The rail: 60 ft of 2 by 4s; the Flyer left it after a run of about 40 ft. */
export const WRIGHT_RAIL = Object.freeze({ length: 60 * FT, run: 40 * FT });

/** Options of {@link wrightFlightPose}. */
export interface WrightFlightOptions {
  /** Headwind, m/s. Default 12.07 (27 mph). */
  wind?: number;
  /** Height of the Flyer's skids above the sand while on the rail (the rail and its truck). Default 0.2. */
  railTop?: number;
  /** Propeller revolutions per minute. Default 350. */
  rpm?: number;
  /** Seconds of engine running before release (the propellers already turn at t = 0). Default 4. */
  warmup?: number;
}

/** The Flyer's pose at time t of a flight; t = 0 is the release from the rail's start. */
export interface WrightFlightPose {
  /** Position of the Flyer's origin: x across, y the skids' height above the sand, z along the flight from the rail's start. */
  position: [number, number, number];
  /** Nose up, radians. */
  pitch: number;
  /** Right wing down, radians. */
  roll: number;
  /** Elevator deflection, radians (leading edge up positive). */
  elevator: number;
  /** Propeller angle, radians (multiply by each propeller's spin). */
  propeller: number;
  phase: 'rail' | 'air' | 'landed';
  /** Seconds the whole flight lasts: rail run, air time, slide. */
  duration: number;
}

/**
 * The pose of the Flyer at time `t` seconds of flight `n` (1 to 4). The rail run accelerates uniformly over the
 * 40 ft run to the ground speed of the flight; in the air the skids follow a rise and fall over the flight with a
 * pitching undulation of about 3 s (the pilot over-controlling the sensitive elevator, the "up and down" course of the
 * diaries), damped on the long fourth flight; the pitch is a 4 degree angle of attack plus the climb angle through
 * the air (vertical speed over the airspeed: ground speed plus the headwind); the flight ends where the sources put it.
 */
export function wrightFlightPose(n: number, t: number, options: WrightFlightOptions = {}): WrightFlightPose {
  const flight = WRIGHT_FLIGHTS_1903.find((f) => f.n === n);
  if (!flight) throw new RangeError(`wrightFlightPose: flight ${n} is not one of the four; pass 1, 2, 3 or 4`);
  if (!Number.isFinite(t)) throw new RangeError('wrightFlightPose: t is not finite; pass seconds after release as a finite number');
  const wind = options.wind ?? (27 * 1609.344) / 3600;
  const railTop = options.railTop ?? 0.2;
  const rpm = options.rpm ?? 350;
  const warmup = options.warmup ?? 4;
  const vg = flight.distance / flight.seconds;
  const vAir = vg + wind;
  const run = WRIGHT_RAIL.run;
  const tRail = (2 * run) / vg;
  const slide = 1.2;
  const tSlide = (2 * slide) / vg;
  const duration = tRail + flight.seconds + tSlide;
  const propeller = (2 * Math.PI * rpm * (Math.max(t, -warmup) + warmup)) / 60;
  const height = (u: number, ta: number) => {
    const env = Math.sin(Math.PI * Math.min(1, Math.max(0, u))) ** 0.5;
    const decay = n === 4 ? 0.15 + 0.85 * Math.exp(-ta / 14) : 1;
    const und = 1 + 0.45 * decay * Math.sin((2 * Math.PI * ta) / 3.1 - 0.4);
    return (flight.height - railTop) * env * (und / 1.45);
  };
  if (t <= tRail) {
    const tc = Math.max(0, t);
    const z = 0.5 * (vg / tRail) * tc * tc;
    return { position: [0, railTop, z], pitch: 0, roll: 0, elevator: 0, propeller, phase: 'rail', duration };
  }
  const ta = t - tRail;
  if (ta <= flight.seconds) {
    const u = ta / flight.seconds;
    const h = height(u, ta);
    const dt = 0.02;
    const vz = (height((ta + dt) / flight.seconds, ta + dt) - height((ta - dt) / flight.seconds, ta - dt)) / (2 * dt);
    const az = (height((ta + dt) / flight.seconds, ta + dt) - 2 * h + height((ta - dt) / flight.seconds, ta - dt)) / (dt * dt);
    // Lift off from the rail top, blending its height into the climb over the first second.
    const blend = Math.min(1, ta / 1);
    const y = railTop * (1 - blend) + h + railTop * blend * (1 - u);
    const gamma = Math.atan2(vz, vAir);
    const pitch = Math.max(-0.35, Math.min(0.35, (4 * Math.PI) / 180 + gamma));
    const roll = 0.035 * Math.sin((2 * Math.PI * ta) / 4.3 + 1.1) * (n === 4 ? 1 : 0.7);
    const elevator = Math.max(-0.3, Math.min(0.3, -0.04 * az));
    return { position: [0, Math.max(0, y), run + vg * ta], pitch, roll, elevator, propeller, phase: 'air', duration };
  }
  const ts = Math.min(tSlide, ta - flight.seconds);
  const z = run + flight.distance + vg * ts - (0.5 * vg * ts * ts) / tSlide;
  return { position: [0, 0, z], pitch: 0, roll: 0, elevator: 0, propeller, phase: 'landed', duration };
}
