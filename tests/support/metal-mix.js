// KB3240 and KB3240b: the glTF 2.0 Appendix B metal/dielectric mix, written from the specification (not from any shader),
// and a way to run one shipped direct light on the CPU. material = mix(dielectric_brdf, metal_brdf, metallic): only the
// dielectric has a diffuse lobe, weighted by 1 minus the dielectric Fresnel (F0 0.04); the specular parts sum to Schlick
// at the mixed F0. Lambert, GGX D (Walter et al. 2007, eq. 33), height-correlated Smith G2 (Heitz 2014, eq. 99).
import { readFileSync } from 'node:fs';
import * as terms from '../../packages/shared/light-terms.js';
import { wgslModule } from './wgsl-eval.js';

export const normalize = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

/** Radiance per channel (cosine included, unit light) of the specification's mix for `base` (linear RGB). */
export function metalMixReference({ base, metal, roughness, n, v, l }) {
  const h = normalize(v.map((x, i) => x + l[i])),
    nl = Math.max(dot(n, l), 0),
    nv = Math.max(dot(n, v), 0.0001),
    nh = Math.max(dot(n, h), 0),
    vh = Math.max(dot(v, h), 0),
    a2 = roughness ** 4,
    d = a2 / (Math.PI * (nh * nh * (a2 - 1) + 1) ** 2),
    g = (2 * nl * nv) / (nl * Math.sqrt(a2 + (1 - a2) * nv * nv) + nv * Math.sqrt(a2 + (1 - a2) * nl * nl)),
    specular = (d * g) / (4 * nl * nv),
    w = (1 - vh) ** 5;
  return base.map((c) => {
    const dielectric = (1 - (0.04 + 0.96 * w)) * (c / Math.PI) + (0.04 + 0.96 * w) * specular,
      metallic = (c + (1 - c) * w) * specular;
    return ((1 - metal) * dielectric + metal * metallic) * nl;
  });
}

/**
 * Head-on light and view (n = v = l, so vh = nh = nl = nv = 1) at roughness 1: D = 1 / pi, G = 1, the dielectric Fresnel
 * is 0.04 and the mixed one F0 = mix(0.04, base, metal), so the spec's value is
 * ((1 - metal) 0.96 base + F0 / 4) / pi per channel. At base 0.5, metal 0.5: (0.24 + 0.0675) / pi = 0.0978817...,
 * where the old metal-mixed weight (1 - F0) gives (0.1825 + 0.0675) / pi = 0.0795775 (KB3240b).
 */
export const headOn = {
  base: [0.5, 0.5, 0.5],
  metal: 0.5,
  roughness: 1,
  expected: 0.3075 / Math.PI,
  old: 0.25 / Math.PI,
};

/** Part-metal cases off the head-on axis: every metal value, three roughnesses, one oblique light and view. */
export function* metalMixCases() {
  const n = normalize([0.3, 0.5, 0.8]),
    v = normalize([0.4, 0.27, 0.87]),
    l = normalize([0.4, 0.7, 0.6]),
    base = [0.6038, 0.4397, 0.0123];
  for (const metal of [0, 1 / 6, 0.5, 5 / 6, 1])
    for (const roughness of [0.25, 0.5, 1]) yield { base, metal, roughness, n, v, l };
}

/** The `${...}` placeholders of a TypeScript shader template that name shared light terms, filled in. */
export const fillTerms = (text) =>
  text.replace(/\$\{\s*(?:\/\*\s*@__PURE__\s*\*\/\s*)?([^}]*)\}/g, (whole, expression) => {
    const names = Object.keys(terms);
    try {
      const value = new Function(...names, `return (${expression});`)(...names.map((name) => terms[name]));
      return typeof value === 'string' ? value : whole;
    } catch {
      return whole;
    }
  });

/** `path` (from the repository root) as text, with its shared light-term placeholders filled in. */
export const shaderSource = (path) => fillTerms(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));

/**
 * The statements of `text` from `start` (included) up to `marker` (excluded), and the expression after `marker` that ends
 * where the direct light's `)*nl` closes, as one WGSL function `site(params)` returning that expression: the shipped
 * direct light run through tests/support/wgsl-eval.js. `prefix` holds statements the site declares before `start`;
 * `glsl` reads GLSL declarations (the WebGL2 preview) and turns them into WGSL first.
 */
export function directLightSite(text, { start, marker, params, prefix = '', close = ')*nl', glsl = false }) {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`no ${start}`);
  const at = text.indexOf(marker, from);
  if (at < 0) throw new Error(`no ${marker} after ${start}`);
  const end = text.indexOf(close, at);
  if (end < 0) throw new Error(`no ${close} after ${marker}`);
  const shipped = text.slice(from, at),
    statements = glsl ? glslToWgsl(shipped) : shipped,
    sliced = text.slice(at + marker.length, end + close.length),
    expression = glsl ? sliced.replace(/\bvec3\(/g, 'vec3f(') : sliced;
  const module = wgslModule(`fn site(${params})->vec3f {${prefix}${statements}return ${expression};}`);
  return { statements, expression, call: (...args) => module.call('site', ...args) };
}

/** GLSL declarations (`float a=1.0,b=a;vec3 c=vec3(0.04);`) as WGSL `let` statements, for the WebGL2 preview. */
export function glslToWgsl(text) {
  const out = [];
  for (const statement of text.split(';').filter((s) => s.trim())) {
    const match = /^\s*(?:float|vec3|vec4)\s+([\s\S]*)$/.exec(statement);
    if (!match) throw new Error(`not a declaration: ${statement}`);
    let depth = 0,
      part = '';
    for (const c of match[1]) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) {
        out.push(`let ${part};`);
        part = '';
      } else part += c;
    }
    out.push(`let ${part};`);
  }
  return out.join('').replace(/\bvec3\(/g, 'vec3f(');
}
