// Scene fog for the shaders of water, VFX, splats, points and lines: the same maths as @margoengine/environment's Fog
// (linear near/far, exp2 density, height falloff), read from any object with Fog's fields, so those packages do not
// import environment.
import { LinearToSRGB, parseColor } from '@margoengine/math/color';

/** Bytes of the fog uniform: colour and height, near/far/density/falloff, camera position. */
export const FOG_BYTES = 48;

/** WGSL: the fog uniform at `@group(group) @binding(binding)` and `fogAmount(world position)`, 0 (clear) to 1. */
export const fogWgsl = (group, binding) => `
struct MargoFog {color:vec4f,params:vec4f,eye:vec4f}
@group(${group}) @binding(${binding}) var<uniform> margoFog:MargoFog;
fn fogAmount(p:vec3f)->f32 {
  let d=distance(p,margoFog.eye.xyz);let q=margoFog.params;
  let amount=select(clamp((d-q.x)/max(q.y-q.x,1e-6),0.0,1.0),1.0-exp(-q.z*q.z*d*d),q.z>0.0);
  return amount*exp(-q.w*max(p.y-margoFog.color.w,0.0));
}
`;

const measure = (value, fallback, label, min) => {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min)
    throw new RangeError(`Fog ${label} is ${String(v)}; pass a finite number${min === 0 ? ', 0 or more' : ''}`);
  return v;
};

/** Throws when `fog` is neither null nor an object; `setFog` calls it so a wrong argument fails where it is passed. */
export function checkFog(fog) {
  if (fog !== null && (typeof fog !== 'object' || Array.isArray(fog)))
    throw new TypeError('Fog must be an object with Fog fields; pass an environment Fog, such an object or null');
  if (fog) writeFog(fog, [0, 0, 0], new Float32Array(12));
  return fog;
}

/**
 * Validates `fog` and writes the fog uniform into `out` (12 floats): linear colour (sRGB-encoded with `encode`, for
 * shaders that write raw values to an 8-bit target) and height, near, far, density, falloff, and `eye`. A disabled fog
 * writes Fog's off values (near and far at the float maximum, density 0), so the shaders mix in zero fog.
 */
export function writeFog(fog, eye, out, encode = false) {
  const enabled = fog.enabled ?? true;
  if (typeof enabled !== 'boolean') throw new TypeError(`Fog enabled is ${String(enabled)}; pass true or false`);
  const height = measure(fog.height, 0, 'height', -Infinity),
    near = measure(fog.near, 1, 'near', 0),
    far = measure(fog.far, 1000, 'far', 0),
    density = measure(fog.density, 0, 'density', 0),
    falloff = measure(fog.heightFalloff, 0, 'heightFalloff', 0);
  parseColor(fog.color ?? '#ffffff', out, 0);
  if (encode) for (let i = 0; i < 3; i++) out[i] = LinearToSRGB(out[i]);
  out[3] = height;
  out[4] = near;
  out[5] = far;
  out[6] = density;
  out[7] = falloff;
  if (!enabled) {
    out.fill(0, 0, 8);
    out[4] = out[5] = 3.4028234663852886e38;
  }
  out[8] = eye[0];
  out[9] = eye[1];
  out[10] = eye[2];
  out[11] = 0;
}
