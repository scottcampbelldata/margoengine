// COLLADA <library_cameras> and <library_lights> placed by <instance_camera> and <instance_light>, and their
// conversion to what an engine camera and the light packages take. Written from the COLLADA 1.4.1 and 1.5
// specifications.
import type { MutableVec3 } from '@margoengine/math';
import { LoaderError } from './types.js';
import { AXES, F, IDENTITY, kid, multiply, numbers, ref, type Matrix } from './dae-common.js';
import type { DAEPose } from './dae-pose.js';
import type { DAENode, LoadedDAE } from './dae.js';
import type { XMLElement } from './xml.js';

/**
 * An `<instance_camera>`: the `<camera>`'s `technique_common` optics on the node that instances it. The camera looks
 * down the -Z of its frame with +Y up. Angles are degrees as written; distances and magnifications are in meters.
 */
export interface DAECamera {
  /** The `<camera>`'s id. */
  id?: string;
  /** The `<camera>`'s name. */
  name?: string;
  /** The node holding the `<instance_camera>`. */
  node: DAENode;
  /** Which optics the camera has. */
  type: 'perspective' | 'orthographic';
  /**
   * What the file gives: `xfov` alone, `yfov` alone, both, or one with `aspectRatio` (width over height). Full angles
   * in degrees; `znear` and `zfar` in meters.
   */
  perspective?: { xfov?: number; yfov?: number; aspectRatio?: number; znear: number; zfar: number };
  /** Half-width `xmag` and/or half-height `ymag` of the view (read as glTF's), or one with `aspectRatio`; meters. */
  orthographic?: { xmag?: number; ymag?: number; aspectRatio?: number; znear: number; zfar: number };
  /**
   * The camera's frame at rest in Y-up meters, column-major: translation is the position, -Z (column 2 negated) the
   * view direction and +Y (column 1) the up direction. A posed frame is `daeFrame(dae, camera.node, pose)`.
   */
  matrix: number[];
}

/**
 * An `<instance_light>`: the `<light>`'s `technique_common` on the node that instances it, at rest in Y-up meters.
 * Attenuation is `1 / (constant + linear d + quadratic d^2)` with d in meters (the file's coefficients divided by
 * `meter` and `meter^2`).
 */
export interface DAELight {
  /** The `<light>`'s id. */
  id?: string;
  /** The `<light>`'s name. */
  name?: string;
  /** The node holding the `<instance_light>`. */
  node: DAENode;
  /** The `technique_common` light element. */
  type: 'ambient' | 'directional' | 'point' | 'spot';
  /** Linear RGB as written (it carries the intensity, so it may exceed 1). */
  color: MutableVec3;
  /** Point and spot: default 1. */
  constantAttenuation?: number;
  /** Point and spot, per meter: default 0. */
  linearAttenuation?: number;
  /** Point and spot, per square meter: default 0. */
  quadraticAttenuation?: number;
  /** Spot: the full cone angle in degrees, default 180 (a hemisphere). */
  falloffAngle?: number;
  /** Spot: the exponent of cos(angle from the axis) inside the cone, default 0 (even light up to the edge). */
  falloffExponent?: number;
  /** World position in meters. */
  position: MutableVec3;
  /** Unit world direction the light travels: the frame's -Z (meaningful for directional and spot lights). */
  direction: MutableVec3;
  /** The light's frame at rest, Y-up meters, column-major, as {@link DAECamera.matrix}. */
  matrix: number[];
}

/** @internal An instance found while reading the scene, resolved once the hierarchy exists. */
export interface DAEPlacement {
  node: DAENode;
  kind: 'camera' | 'light';
  url: string;
}

const rotation = (upAxis: LoadedDAE['upAxis']): Matrix => {
  const axis = AXES[upAxis],
    m = [...IDENTITY];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 4 + r] = axis[r * 3 + c];
  return m;
};

const normalized = (x: number, y: number, z: number): MutableVec3 => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};

/**
 * A node's camera or light frame in Y-up meters, column-major: the node's world matrix (from `pose`, else at rest)
 * times the up-axis rotation, so the file's local -Z view axis and +Y up stay the frame's -Z and +Y. Throws a
 * TypeError when the node is not in the document.
 */
export function daeFrame(dae: Pick<LoadedDAE, 'nodes' | 'upAxis'>, node: DAENode, pose?: DAEPose): number[] {
  let world = pose?.world.get(node);
  if (!world) {
    const find = (n: DAENode, parent: Matrix): Matrix | undefined => {
      const w = multiply(parent, n.matrix);
      if (n === node) return w;
      for (const child of n.children) {
        const found = find(child, w);
        if (found) return found;
      }
      return undefined;
    };
    for (const root of dae.nodes) if ((world = find(root, IDENTITY))) break;
  }
  if (!world) throw new TypeError('daeFrame needs a node of this document; pass camera.node or light.node');
  return multiply(world, rotation(dae.upAxis));
}

function value(e: XMLElement | undefined, what: string, fallback?: number): number | undefined {
  if (!e) return fallback;
  const v = numbers(e.text, what);
  if (v.length !== 1 || !Number.isFinite(v[0]))
    throw new LoaderError(F, 'syntax', `${what} must be one finite number; write it as a plain number`);
  return v[0];
}

type Optics = Pick<DAECamera, 'type' | 'perspective' | 'orthographic'>;

function readOptics(camera: XMLElement, meter: number, warn: (message: string) => void): Optics | undefined {
  const id = camera.attributes.id ?? camera.attributes.name ?? '',
    common = kid(kid(camera, 'optics'), 'technique_common'),
    perspective = kid(common, 'perspective'),
    e = perspective ?? kid(common, 'orthographic');
  if (!e) {
    warn(`camera "${id}" has no technique_common <perspective> or <orthographic> and is not imported`);
    return;
  }
  const what = `camera "${id}" <${e.name}>`,
    read = (name: string) => value(kid(e, name), `${what} <${name}>`),
    near = read('znear'),
    far = read('zfar');
  if (near === undefined || far === undefined)
    throw new LoaderError(F, 'syntax', `${what} needs <znear> and <zfar>; add both`);
  if (!(far > near) || (perspective && !(near > 0)))
    throw new LoaderError(
      F,
      'range',
      `${what} znear ${near} and zfar ${far} are invalid; give ${perspective ? '0 < znear' : 'znear'} < zfar`,
    );
  const [xName, yName] = perspective ? ['xfov', 'yfov'] : ['xmag', 'ymag'],
    x = read(xName),
    y = read(yName);
  let aspect = read('aspect_ratio');
  if (x === undefined && y === undefined)
    throw new LoaderError(
      F,
      'syntax',
      `${what} needs <${xName}> or <${yName}>; add one (and <aspect_ratio> if wanted)`,
    );
  if (x !== undefined && y !== undefined && aspect !== undefined) {
    warn(`${what} gives ${xName}, ${yName} and aspect_ratio; aspect_ratio is ignored (give only two of them)`);
    aspect = undefined;
  }
  for (const [name, v] of [
    [xName, x],
    [yName, y],
  ] as const)
    if (v !== undefined && !(v > 0 && (!perspective || v < 180)))
      throw new LoaderError(
        F,
        'range',
        `${what} <${name}> ${v} is invalid; give ${perspective ? 'degrees between 0 and 180' : 'a size > 0'}`,
      );
  if (aspect !== undefined && !(aspect > 0))
    throw new LoaderError(F, 'range', `${what} <aspect_ratio> ${aspect} is invalid; give width / height > 0`);
  const scale = perspective ? 1 : meter,
    optics: { znear: number; zfar: number; [key: string]: number } = { znear: near * meter, zfar: far * meter };
  if (x !== undefined) optics[xName] = x * scale;
  if (y !== undefined) optics[yName] = y * scale;
  if (aspect !== undefined) optics.aspectRatio = aspect;
  return perspective ? { type: 'perspective', perspective: optics } : { type: 'orthographic', orthographic: optics };
}

const LIGHTS: readonly string[] = ['ambient', 'directional', 'point', 'spot'];
type LightData = Omit<DAELight, 'node' | 'position' | 'direction' | 'matrix'>;

function readLight(light: XMLElement, meter: number, warn: (message: string) => void): LightData | undefined {
  const id = light.attributes.id ?? light.attributes.name ?? '',
    e = kid(light, 'technique_common')?.children.find((c) => LIGHTS.includes(c.name));
  if (!e) {
    warn(`light "${id}" has no technique_common ambient, directional, point or spot light and is not imported`);
    return;
  }
  const what = `light "${id}" <${e.name}>`,
    colorElement = kid(e, 'color'),
    color = colorElement ? numbers(colorElement.text, `${what} <color>`) : [1, 1, 1];
  if (color.length !== 3 || !color.every((c) => Number.isFinite(c) && c >= 0))
    throw new LoaderError(F, 'syntax', `${what} <color> needs 3 finite numbers >= 0 (r g b), got ${color.length}`);
  const result: LightData = { type: e.name as DAELight['type'], color: [color[0], color[1], color[2]] };
  if (light.attributes.id !== undefined) result.id = light.attributes.id;
  if (light.attributes.name !== undefined) result.name = light.attributes.name;
  if (result.type === 'point' || result.type === 'spot') {
    const read = (name: string, fallback: number): number => {
      const v = value(kid(e, name), `${what} <${name}>`, fallback)!;
      if (!(v >= 0)) throw new LoaderError(F, 'range', `${what} <${name}> ${v} is negative; give a number >= 0`);
      return v;
    };
    const constant = read('constant_attenuation', 1),
      linear = read('linear_attenuation', 0),
      quadratic = read('quadratic_attenuation', 0);
    if (!(constant || linear || quadratic))
      throw new LoaderError(
        F,
        'range',
        `${what} attenuation is all zero; give constant_attenuation 1 (or any term > 0)`,
      );
    result.constantAttenuation = constant;
    result.linearAttenuation = linear / meter;
    result.quadraticAttenuation = quadratic / (meter * meter);
  }
  if (result.type === 'spot') {
    const angle = value(kid(e, 'falloff_angle'), `${what} <falloff_angle>`, 180)!,
      exponent = value(kid(e, 'falloff_exponent'), `${what} <falloff_exponent>`, 0)!;
    if (!(angle > 0 && angle <= 360))
      throw new LoaderError(F, 'range', `${what} <falloff_angle> ${angle} is invalid; give degrees in (0, 360]`);
    if (!(exponent >= 0))
      throw new LoaderError(F, 'range', `${what} <falloff_exponent> ${exponent} is negative; give a number >= 0`);
    result.falloffAngle = angle;
    result.falloffExponent = exponent;
  }
  return result;
}

/** @internal Resolves the scene's camera and light instances into data at rest. */
export function placeScene(
  dae: Pick<LoadedDAE, 'nodes' | 'upAxis' | 'meter'>,
  ids: Map<string, XMLElement>,
  placements: readonly DAEPlacement[],
  warn: (message: string) => void,
): { cameras: DAECamera[]; lights: DAELight[] } {
  const cameras: DAECamera[] = [],
    lights: DAELight[] = [],
    optics = new Map<XMLElement, Optics | undefined>(),
    sources = new Map<XMLElement, LightData | undefined>();
  for (const { node, kind, url } of placements) {
    const e = ids.get(ref(url));
    if (e?.name !== kind) {
      warn(`instance_${kind} "${url}" names no <${kind}>`);
      continue;
    }
    const frame = daeFrame(dae, node);
    if (kind === 'camera') {
      if (!optics.has(e)) optics.set(e, readOptics(e, dae.meter, warn));
      const read = optics.get(e);
      if (!read) continue;
      const camera: DAECamera = { node, ...structuredClone(read), matrix: frame };
      if (e.attributes.id !== undefined) camera.id = e.attributes.id;
      if (e.attributes.name !== undefined) camera.name = e.attributes.name;
      cameras.push(camera);
    } else {
      if (!sources.has(e)) sources.set(e, readLight(e, dae.meter, warn));
      const read = sources.get(e);
      if (!read) continue;
      lights.push({
        ...structuredClone(read),
        node,
        position: [frame[12], frame[13], frame[14]],
        direction: normalized(-frame[8], -frame[9], -frame[10]),
        matrix: frame,
      });
    }
  }
  return { cameras, lights };
}

/**
 * What an engine camera takes to view through a {@link DAECamera}: `Object.assign(engine.camera, view)`. `fov` is
 * vertical degrees (perspective only); an orthographic camera sets `project` (core's `Camera.project`), a perspective
 * one clears it.
 */
export interface DAECameraView {
  /** Eye position in meters. */
  position: MutableVec3;
  /** One meter ahead along the view, so orbit controls turn around that point. */
  target: MutableVec3;
  /** Unit screen-up direction. */
  up: MutableVec3;
  /** Vertical field of view in degrees (perspective). */
  fov?: number;
  /** Near clip distance in meters. */
  near: number;
  /** Far clip distance in meters. */
  far: number;
  /** Width over height when the camera fixes it (`aspect_ratio`, or both fovs or both magnifications). */
  aspect?: number;
  /** Orthographic projection for core's `Camera.project`; undefined for perspective (clears an earlier one). */
  project: ((out: Float64Array, aspect: number, webgpu: boolean) => void) | undefined;
}

/** Options of {@link daeCameraView}. */
export interface DAECameraViewOptions {
  /** Pose the camera's node (else at rest). */
  pose?: DAEPose;
  /** The viewport's width over height: needed for a perspective camera that gives only `xfov`. */
  aspect?: number;
}

const tan = (degrees: number): number => Math.tan((degrees * Math.PI) / 360);
const atan = (t: number): number => (Math.atan(t) * 360) / Math.PI;

/**
 * How an engine camera views through `dae.cameras[camera]` (default the first), from its node's frame at rest (or at
 * `options.pose`). Perspective follows the spec's combinations: `yfov` is the vertical angle; `xfov` with
 * `aspect_ratio` gives yfov = 2 atan(tan(xfov / 2) / aspect); `xfov` with `yfov` fixes the aspect as
 * tan(xfov / 2) / tan(yfov / 2) and keeps yfov; `xfov` alone takes `options.aspect`. Orthographic: `ymag` is the
 * half-height and the width follows the viewport; `xmag` alone is the half-width (the height follows the viewport);
 * `xmag` with `aspect_ratio` gives a half-height of xmag / aspect. Throws a RangeError when the camera does not exist
 * or `xfov` alone has no valid `options.aspect`.
 */
export function daeCameraView(dae: LoadedDAE, camera = 0, options: DAECameraViewOptions = {}): DAECameraView {
  const def = Number.isInteger(camera) ? dae.cameras[camera] : undefined;
  if (!def) throw new RangeError(`DAE camera ${camera} does not exist; pass an index below ${dae.cameras.length}`);
  const m = options.pose ? daeFrame(dae, def.node, options.pose) : def.matrix,
    forward = normalized(-m[8], -m[9], -m[10]),
    view: DAECameraView = {
      position: [m[12], m[13], m[14]],
      target: [m[12] + forward[0], m[13] + forward[1], m[14] + forward[2]],
      up: normalized(m[4], m[5], m[6]),
      near: 0,
      far: 0,
      project: undefined,
    };
  if (def.perspective) {
    const { xfov, yfov, aspectRatio, znear, zfar } = def.perspective;
    let aspect = xfov !== undefined && yfov !== undefined ? tan(xfov) / tan(yfov) : aspectRatio;
    if (aspect !== undefined) view.aspect = aspect;
    if (yfov === undefined && aspect === undefined) {
      aspect = options.aspect;
      if (typeof aspect !== 'number' || !(aspect > 0) || !Number.isFinite(aspect))
        throw new RangeError(`DAE camera ${camera} gives only xfov; pass {aspect: viewport width / height}`);
    }
    view.fov = yfov ?? atan(tan(xfov!) / aspect!);
    view.near = znear;
    view.far = zfar;
    return view;
  }
  const { xmag, ymag, aspectRatio, znear: near, zfar: far } = def.orthographic!,
    depth = far - near,
    fixed = ymag ?? (aspectRatio !== undefined ? xmag! / aspectRatio : undefined);
  view.near = near;
  view.far = far;
  if (xmag !== undefined && ymag !== undefined) view.aspect = xmag / ymag;
  else if (aspectRatio !== undefined) view.aspect = aspectRatio;
  // Column-major; WebGPU depth is reversed (near 1, far 0) like core's perspective, WebGL's runs -1 to 1.
  view.project = (out, aspect, webgpu) => {
    const halfHeight = fixed ?? xmag! / aspect;
    out.fill(0);
    out[0] = 1 / (halfHeight * aspect);
    out[5] = 1 / halfHeight;
    out[10] = webgpu ? 1 / depth : -2 / depth;
    out[14] = webgpu ? far / depth : -(far + near) / depth;
    out[15] = 1;
  };
  return view;
}

/** A point or spot light in the shape of @margoengine/clustered's `PointLight` and `SpotLight`, for `setLights`. */
export interface DAELocalLight {
  /** World position in meters. */
  position: MutableVec3;
  /** Where the light falls to 1/256 (0, unlimited, when it does not fall off). */
  range: number;
  /** Unit linear RGB (the brightest channel is 1). */
  color: MutableVec3;
  /** The brightest channel over the attenuation term kept. */
  intensity: number;
  /** 2 for inverse-square, 1 for linear, 0 for constant attenuation (the strongest term that is set). */
  decay: number;
  /** Spot: the unit direction the cone points along. */
  direction?: MutableVec3;
  /** Spot: the cone half-angle in radians (half the falloff angle, at most pi / 2). */
  outerAngle?: number;
  /** Spot: where the edge starts fading, from the falloff exponent. */
  innerAngle?: number;
}

/** A directional light in the shape of @margoengine/clustered/directional's `DirectionalLight`. */
export interface DAEDirectionalLight {
  /** Unit direction the light travels (from the light toward the scene). */
  direction: MutableVec3;
  /** Unit linear RGB. */
  color: MutableVec3;
  /** The brightest channel of the light's color. */
  intensity: number;
}

/** The document's lights converted for the engine by {@link daeEngineLights}. */
export interface DAEEngineLights {
  /**
   * The first directional light, for core's sun: `engine.scene.lighting.direction.set([...sun.toward, sun.intensity])` and
   * `engine.scene.lighting.radiance.set(sun.color)`.
   */
  sun?: { toward: MutableVec3; color: MutableVec3; intensity: number };
  /**
   * Every ambient light summed, for core's ambient: `engine.scene.lighting.ambient.set(ambient.color)` and
   * `engine.scene.lighting.radiance[3] = ambient.intensity`.
   */
  ambient?: { color: MutableVec3; intensity: number };
  /** The other directional lights, for `DirectionalLights.setLights`. */
  directional: DAEDirectionalLight[];
  /** Point and spot lights, for `Clustered.setLights`. */
  local: DAELocalLight[];
}

/** Options of {@link daeEngineLights}. */
export interface DAEEngineLightOptions {
  /** Place the lights at this pose (else at rest). */
  pose?: DAEPose;
  /** Multiplies every intensity (an exposure). Default 1. */
  intensity?: number;
}

/** A color split into its brightest channel (times `scale`) and the color divided by it. */
const split = (c: readonly number[], scale: number): { color: MutableVec3; intensity: number } => {
  const peak = Math.max(c[0], c[1], c[2]);
  return peak > 0
    ? { color: [c[0] / peak, c[1] / peak, c[2] / peak], intensity: peak * scale }
    : { color: [0, 0, 0], intensity: 0 };
};

/**
 * The document's lights (at rest, or at `options.pose`) in the shapes the engine takes. Colors are split into a unit
 * color and an intensity (the brightest channel). The first directional light is core's sun, the others are for
 * @margoengine/clustered/directional; ambient lights add up into core's ambient. Point and spot attenuation
 * `1 / (c + l d + q d^2)` is approximated by its strongest set term: q gives inverse-square (`decay` 2,
 * intensity / q), else l gives `decay` 1 (intensity / l), else c gives `decay` 0 (intensity / c, `range` 0). The
 * dropped terms make the light brighter near its position than the file's, and the same far away. `range` ends where
 * intensity / d^decay is 1/256. A spot's full `falloff_angle` becomes `outerAngle` (half of it, at most a
 * hemisphere); its `falloff_exponent` e (cos^e fading within the cone) becomes an `innerAngle` where cos^e is 1/2, a
 * hard edge for e = 0. Throws a RangeError for a negative or non-finite `intensity`.
 */
export function daeEngineLights(dae: LoadedDAE, options: DAEEngineLightOptions = {}): DAEEngineLights {
  const scale = options.intensity ?? 1;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0)
    throw new RangeError(`DAE light intensity ${scale} is invalid; pass a finite number >= 0`);
  const out: DAEEngineLights = { directional: [], local: [] },
    ambient = [0, 0, 0];
  let ambients = 0;
  for (const light of dae.lights) {
    if (light.type === 'ambient') {
      ambients++;
      for (let c = 0; c < 3; c++) ambient[c] += light.color[c];
      continue;
    }
    const frame = options.pose ? daeFrame(dae, light.node, options.pose) : light.matrix,
      direction = normalized(-frame[8], -frame[9], -frame[10]),
      { color, intensity } = split(light.color, scale);
    if (light.type === 'directional') {
      if (!out.sun) out.sun = { toward: [-direction[0], -direction[1], -direction[2]], color, intensity };
      else out.directional.push({ direction, color, intensity });
      continue;
    }
    const q = light.quadraticAttenuation ?? 0,
      l = light.linearAttenuation ?? 0,
      [decay, term] = q > 0 ? [2, q] : l > 0 ? [1, l] : [0, light.constantAttenuation ?? 1],
      strength = intensity / term,
      local: DAELocalLight = {
        position: [frame[12], frame[13], frame[14]],
        range: decay ? (256 * strength) ** (1 / decay) : 0,
        color,
        intensity: strength,
        decay,
      };
    if (light.type === 'spot') {
      const outer = Math.min(((light.falloffAngle ?? 180) * Math.PI) / 360, Math.PI / 2),
        e = light.falloffExponent ?? 0;
      local.direction = direction;
      local.outerAngle = outer;
      local.innerAngle = e > 0 ? Math.min(outer, Math.acos(0.5 ** (1 / e))) : outer;
    }
    out.local.push(local);
  }
  if (ambients) out.ambient = split(ambient, scale);
  return out;
}
