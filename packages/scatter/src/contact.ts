/**
 * How lit GPU `Scatter` and `ScatterTiles` objects meet the ground (see `ScatterOptions.base` and
 * `ScatterOptions.skyOcclusion`).
 */
import { occludeAmbient } from '../../shared/occlude-ambient.js';

/** The foot of an object (see `ScatterOptions.base`): metres are at instance scale 1 and grow with the instance. */
export interface ScatterBase {
  /** Height of the band above the ground, above 0 and up to 1,000. It fades from the ground line up. */
  height: number;
  /** Share of the sky's light lost at the ground line, 0-1 (default 0.5): contact occlusion, fading up the band. */
  shade?: number;
  /** Albedo, linear RGB 0-1, the foot turns toward: moss on a stone, soil splashed on a trunk. Default none. */
  tint?: readonly [number, number, number];
  /** How far the albedo turns to `tint` at the ground line, 0-1 (default 0.7 with a tint, 0 without). */
  amount?: number;
}
/** Sky light a crown keeps from its own and its neighbours' leaves above (see `ScatterOptions.skyOcclusion`). */
export interface ScatterSkyOcclusion {
  /** Optical depth of the canopy above the ground line, 0-20: the sky's light there is exp(-depth) of the top's. */
  depth: number;
  /** Height above the ground at which the whole sky shows, above 0 and up to 1,000 metres at scale 1. */
  height: number;
}

const within = (v: number, low: number, high: number): boolean => Number.isFinite(v) && v >= low && v <= high;

/**
 * The two material vectors the contact stages read (tint and amount; band height, shade, depth, canopy height), or
 * undefined when both options are unset and the shader stays as it was.
 */
export function contactValues(
  base: ScatterBase | undefined,
  sky: ScatterSkyOcclusion | undefined,
): Float32Array | undefined {
  if (base === undefined && sky === undefined) return undefined;
  const out = new Float32Array(8);
  if (base !== undefined) {
    if (typeof base !== 'object' || base === null) throw new TypeError('Scatter base must be an options object');
    const { height, shade = 0.5, tint, amount = tint ? 0.7 : 0 } = base;
    if (
      !(within(height, 0, 1000) && height > 0) ||
      !within(shade, 0, 1) ||
      !within(amount, 0, 1) ||
      (tint !== undefined && (tint.length !== 3 || !tint.every((v) => within(v, 0, 1))))
    )
      throw new RangeError(
        'Scatter base needs a height above 0 and up to 1000, shade and amount 0-1 and a linear RGB tint of 0-1',
      );
    out.set(tint ?? [0, 0, 0]);
    out[3] = tint ? amount : 0;
    out[4] = height;
    out[5] = shade;
  }
  if (sky !== undefined) {
    if (typeof sky !== 'object' || sky === null) throw new TypeError('Scatter skyOcclusion must be an options object');
    if (!within(sky.depth, 0, 20) || !(within(sky.height, 0, 1000) && sky.height > 0))
      throw new RangeError('Scatter skyOcclusion needs a depth of 0-20 and a height above 0 and up to 1000');
    out[6] = sky.depth;
    out[7] = sky.height;
  }
  return out;
}

/**
 * The lit vertex stage's contact lines, after the pose: the vertex's height above the ground plane through the root
 * (the root sits `sink * scale * (1 + tan(slope))` under it, as the placement put it) over each option's height.
 */
const vertexLines =
  'let footUp=scatterGround(data.rotation.y);let footSize=max(data.position.w,0.0001);' +
  'let footRoot=data.position.xyz+vec3f(0.0,material[3].y*data.position.w*(1.0+length(footUp.xz)/max(footUp.y,0.2)),0.0);' +
  'let footHeight=dot(pose.world-footRoot,footUp)/max(footUp.y,0.2)/footSize;' +
  'o.contact=vec4f(footHeight/max(material[8].x,0.001),footHeight/max(material[8].w,0.001),material[8].y,material[8].z);' +
  'o.contactTint=material[7];';

/** Smoothed value noise on a lattice of hashed corners, so the foot band's upper edge is no ruled line. */
const noise = `
fn contactHash(c:vec3i)->f32 {let u=bitcast<vec3u>(c);var x=(u.x*0x8da6b343u)^(u.y*0xd8163841u)^(u.z*0xcb1ab31fu);x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return f32(x^(x>>16u))/4294967296.0;}
fn contactNoise(p:vec3f)->f32 {
 let c=vec3i(floor(p));let f=fract(p);let s=f*f*(3.0-2.0*f);
 return mix(mix(mix(contactHash(c),contactHash(c+vec3i(1,0,0)),s.x),mix(contactHash(c+vec3i(0,1,0)),contactHash(c+vec3i(1,1,0)),s.x),s.y),
  mix(mix(contactHash(c+vec3i(0,0,1)),contactHash(c+vec3i(1,0,1)),s.x),mix(contactHash(c+vec3i(0,1,1)),contactHash(c+vec3i(1,1,1)),s.x),s.y),s.z);
}
`;

/**
 * Edits a lit scatter shader (core's, already carrying Scatter's other edits and maps) to read the contact values:
 * the foot's tint on the albedo and the sky light kept on every ambient term. `location` is the first free varying.
 */
export function contactStages(code: string, location: number): string {
  const output = '@location(3) material:vec4f',
    end = /return o;\s*\}/;
  const start = code.indexOf('@vertex fn vertex'),
    at = code.indexOf('@fragment fn fragment');
  if (
    start < 0 ||
    at < start ||
    !code.includes(output) ||
    !code.includes('material:array<vec4f,7>') ||
    !end.test(code.slice(start, at))
  )
    throw new TypeError('Scatter base and skyOcclusion need the lit shader they were written for');
  const head = code.slice(0, start).replace('material:array<vec4f,7>', 'material:array<vec4f,9>'),
    vertex = code.slice(start, at).replace(end, vertexLines + 'return o;\n}'),
    stage = code.slice(at),
    mapped = stage.includes(sampled),
    // Without maps the albedo is the input's colour, which a mesh patch may write (a rock's surface does): the stage
    // works on a mutable copy of its input, Scatter's own where it made one.
    body = mapped || copiedLine.test(stage) ? stage : copied(stage);
  // Where the albedo is settled: after the maps' sample, or after the copy at the top of the stage.
  const anchor = mapped ? sampled : copiedLine.exec(body)?.[0];
  if (!anchor) throw new TypeError('Scatter base and skyOcclusion need the lit fragment stage they were written for');
  const cut = body.indexOf(anchor) + anchor.length,
    albedo = mapped ? 'surfColor' : 'i.color';
  const lines =
    '\n let contactFoot=1.0-smoothstep(0.0,1.0,i.contact.x*(0.6+0.8*contactNoise(i.position*9.0)));' +
    'let contactSky=(1.0-i.contact.z*contactFoot)*exp(-i.contact.w*(1.0-clamp(i.contact.y,0.0,1.0)));' +
    `${albedo}=mix(${albedo},i.contactTint.rgb,contactFoot*i.contactTint.a);\n`;
  return (
    noise +
    head.replace(
      output,
      `${output},@location(${location}) contact:vec4f,@location(${location + 1}) @interpolate(flat) contactTint:vec4f`,
    ) +
    vertex +
    body.slice(0, cut) +
    lines +
    occludeAmbient(body.slice(cut), 'contactSky')
  );
}

/** The maps' albedo line (`texturedFragment`), and a mutable input copy as the first line of a fragment stage. */
const sampled = 'var surfColor=surfBase.rgb*i.color;',
  copiedLine = /^@fragment fn fragment\([^{]+\{\s*var i=[^\n]*\n/;
/** A fragment stage that reads its input through a mutable copy named `i`. */
const copied = (stage: string): string =>
  stage.replace(/^(@fragment fn fragment\()i:Output,([^{]+)\{/, '$1varyings:Output,$2{\n var i=varyings;\n');
