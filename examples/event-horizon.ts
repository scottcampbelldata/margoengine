// Event Horizon: a spinning Kerr black hole with geodesic gravitational lensing, a relativistic Doppler-beamed
// accretion disk (Bardeen, Press & Teukolsky 1972; Page & Thorne 1974; Luminet 1979), a tidal disruption stream,
// and 4,500 GPU-instanced plasma knots on Lense-Thirring precessing Keplerian orbits. Rendered with
// @margoengine/shader/raw and @margoengine/post/bloom.
import { createStage } from 'margoengine';
import { OrbitControls } from '@margoengine/controls';
import { Bloom } from '@margoengine/post/bloom';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { paceEngine } from '@margoengine/quality';

// Full-screen geodesic ray marcher: integrates photon trajectories in curved spacetime around a black hole of
// Schwarzschild radius rs = 1.0, sampling the turbulent equatorial accretion disk, secondary Einstein-lensed
// under-disk arcs, photon ring, and lensed deep-field starlight.
const horizonShader = /* wgsl */ `
struct Out { @builtin(position) clip:vec4f, @location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return Out(vec4f(p, 0.0, 1.0), p);
}

fn hash3(p:vec3f)->f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn noise(p:vec3f)->f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3f(1,0,0)), f.x), mix(hash3(i + vec3f(0,1,0)), hash3(i + vec3f(1,1,0)), f.x), f.y),
    mix(mix(hash3(i + vec3f(0,0,1)), hash3(i + vec3f(1,0,1)), f.x), mix(hash3(i + vec3f(0,1,1)), hash3(i + vec3f(1,1,1)), f.x), f.y),
    f.z
  );
}

fn fbm(p:vec3f)->f32 {
  var v = 0.0;
  var a = 0.52;
  var q = p;
  for (var k = 0; k < 4; k++) {
    v += a * noise(q);
    q = q * 2.07 + vec3f(13.1, 7.7, 19.3);
    a *= 0.48;
  }
  return v;
}

// Blackbody-inspired spectral ramp from deep infrared crimson through amber/gold to relativistic blue-white.
fn blackbody(temp:f32)->vec3f {
  let t = clamp(temp, 0.0, 3.4);
  let r = smoothstep(0.0, 0.42, t) * (1.0 + 0.25 * max(t - 1.1, 0.0));
  let g = smoothstep(0.24, 0.98, t) * (0.95 + 0.45 * max(t - 1.15, 0.0));
  let b = smoothstep(0.58, 1.42, t) * (1.2 + 0.95 * max(t - 1.2, 0.0));
  return vec3f(r, g, b);
}

// Lensed celestial sphere: crisp star field plus a dusty galactic plane band behind the black hole.
fn skybox(dir:vec3f)->vec3f {
  let d = normalize(dir);
  let cell = floor(d * 220.0);
  let h = hash3(cell);
  let center = normalize(cell + 0.5 + 0.35 * (vec3f(hash3(cell + 1.1), hash3(cell + 2.3), hash3(cell + 3.7)) - 0.5));
  let ang = max(dot(d, center), 0.0);
  let star = step(0.991, h) * pow(ang, 3600.0) * (1.8 + 3.8 * fract(h * 97.0));
  let starTint = mix(vec3f(1.0, 0.74, 0.52), vec3f(0.65, 0.84, 1.0), fract(h * 43.0));
  let band = exp(-abs(d.y * 2.4 - 0.22 * d.x) * 4.2);
  let dust = fbm(d * 4.8 + vec3f(0.0, 1.2, 2.4));
  let nebula = band * (0.035 + 0.085 * dust) * mix(vec3f(0.15, 0.06, 0.04), vec3f(0.04, 0.1, 0.22), dust);
  return nebula + star * starTint;
}

// Evaluates relativistic disk emission at an equatorial crossing point p, given photon direction rd.
fn sampleDisk(p:vec3f, rd:vec3f, isco:f32)->vec4f {
  let r = length(p.xz);
  let outer = 10.5;
  if (r < isco * 0.92 || r > outer) {
    return vec4f(0.0);
  }
  let t = camera.time;
  let phi = atan2(p.z, p.x);
  // Relativistic Keplerian angular velocity omega = 1 / (r^(3/2) + a)
  let omega = 1.0 / (pow(max(r, isco), 1.5) + uniforms.spin * 0.5);
  let phase = phi - omega * t * 3.8;
  // Logarithmic spiral MRI filaments
  let spiral = 4.6 * log(max(r, 0.5)) + phase;
  let turb = fbm(vec3f(r * 1.45 + sin(phase) * 0.35, cos(spiral) * 1.7, sin(spiral) * 1.7 + t * 0.16));
  let fine = fbm(vec3f(r * 3.8, cos(phase * 2.0) * 2.2, sin(phase * 2.0) * 2.2 - t * 0.25));
  let rings = 0.58 + 0.42 * sin(r * 6.0 - turb * 4.2 + t * 0.8);
  let innerEdge = smoothstep(isco * 0.92, isco * 1.16, r);
  let outerEdge = 1.0 - smoothstep(outer * 0.48, outer, r);
  let profile = innerEdge * outerEdge * pow(isco / max(r, isco), 1.55);

  // Relativistic orbital beta = v/c in the equatorial plane (prograde rotation)
  let tangent = vec3f(-p.z, 0.0, p.x) / max(r, 1e-4);
  let beta = clamp(sqrt(0.5 / max(r - 0.35 * uniforms.spin, 0.42)), 0.0, 0.72);
  let gamma = 1.0 / sqrt(max(1.0 - beta * beta, 0.15));
  // Approaching gas on the left side of the disk is Doppler-boosted (blueshifted & brightened); receding side is redshifted
  let cosTheta = dot(tangent, -rd);
  let doppler = 1.0 / (gamma * (1.0 - beta * cosTheta));
  let beaming = pow(clamp(doppler, 0.28, 2.6), 2.35);

  // Tidal disruption flare wave spiraling inward from r = 8.5 down to ISCO
  var flareBoost = 0.0;
  if (uniforms.flareAge >= 0.0 && uniforms.flareAge < 12.0) {
    let targetR = mix(8.2, isco, clamp(uniforms.flareAge / 6.2, 0.0, 1.0));
    let radialWave = exp(-pow((r - targetR) / 0.75, 2.0));
    let spiralArc = 0.5 + 0.5 * cos(phi * 2.0 + r * 2.1 - uniforms.flareAge * 5.2);
    let decay = exp(-max(uniforms.flareAge - 4.5, 0.0) * 0.55);
    flareBoost = radialWave * spiralArc * decay * 1.65;
  }

  let structure = 0.38 + 0.85 * turb * rings + 0.32 * fine;
  let density = clamp(profile * structure + flareBoost * 0.4, 0.0, 1.0);
  let temp = (pow(isco / max(r, isco), 0.58) * (0.68 + 0.48 * turb) + flareBoost * 0.65) * pow(doppler, 0.92) * uniforms.accretion;
  let col = blackbody(temp) * beaming * density * (1.35 + flareBoost * 1.25) * uniforms.accretion;
  return vec4f(col, clamp(density * 0.9, 0.0, 0.96));
}

@fragment fn fragment(i:Out)->@location(0) vec4f {
  let v = camera.view;
  let right = vec3f(v[0][0], v[1][0], v[2][0]);
  let up = vec3f(v[0][1], v[1][1], v[2][1]);
  let back = vec3f(v[0][2], v[1][2], v[2][2]);
  let proj = camera.projection;
  var rd = normalize(right * i.ndc.x / proj[0][0] + up * i.ndc.y / proj[1][1] - back);
  var pos = camera.position;

  // Schwarzschild radius rs = 1.0; frame-dragging shifts effective horizon and ISCO
  let horizon = 0.52 * (1.0 + sqrt(max(1.0 - uniforms.spin * uniforms.spin, 0.02)));
  let isco = uniforms.isco * 0.5;
  let hVec = cross(pos, rd);
  let h2 = dot(hVec, hVec);

  var accum = vec3f(0.0);
  var trans = 1.0;
  var minR = 100.0;
  var swallowed = false;

  // Symplectic geodesic integration through curved spacetime
  for (var step = 0; step < 112; step++) {
    let r2 = dot(pos, pos);
    let r = sqrt(r2);
    minR = min(minR, r);
    if (r <= horizon) {
      swallowed = true;
      break;
    }
    if (r > 30.0 && dot(pos, rd) > 0.0) {
      break;
    }

    let dt = clamp(0.042 * (r - horizon * 0.85) + 0.011 * r, 0.016, 0.4);
    let invR5 = 1.0 / (r2 * r2 * r + 1e-4);
    let frameDrag = uniforms.spin * 0.28 * cross(vec3f(0.0, 1.0, 0.0), rd) / (r2 * r + 0.05);
    let accel = -1.5 * h2 * pos * invR5 + frameDrag;
    let nextVel = normalize(rd + accel * dt);
    let nextPos = pos + nextVel * dt;

    // Equatorial disk plane crossing (y = 0) — captures primary disk + secondary/tertiary Einstein-lensed arches
    if ((pos.y > 0.0 && nextPos.y <= 0.0) || (pos.y < 0.0 && nextPos.y >= 0.0)) {
      let frac = abs(pos.y) / max(abs(pos.y - nextPos.y), 1e-5);
      let hitPos = mix(pos, nextPos, frac);
      let sample = sampleDisk(hitPos, nextVel, isco);
      accum += trans * sample.rgb;
      trans *= (1.0 - sample.a);
    }

    pos = nextPos;
    rd = nextVel;
    if (trans < 0.015) {
      break;
    }
  }

  // Critical photon-sphere ring on the outside edge of the black hole shadow (purely black inside the shadow)
  if (!swallowed) {
    let rPh = max(uniforms.rPh * 0.42, horizon);
    let ringDist = max(minR - rPh, 0.0);
    let photonRing = exp(-ringDist * 16.0) * (0.75 + 0.45 * uniforms.accretion);
    accum += trans * vec3f(1.0, 0.88, 0.68) * photonRing;
    accum += trans * skybox(rd);
  }
  return margoDisplay(vec4f(accum, 1.0));
}
`;

// 4,500 GPU-instanced relativistic plasma knots orbiting in the disk & bipolar Blandford-Znajek jets,
// occluded behind the black hole shadow so the event horizon remains crisp.
const knotsShader = /* wgsl */ `
struct Out { @builtin(position) clip:vec4f, @location(0) uv:vec2f, @location(1) col:vec3f }
fn h1(n:f32, seed:f32)->f32 { return fract(sin(n * 12.9898 + seed * 78.233) * 43758.5453); }

@vertex fn vertex(@builtin(vertex_index) v:u32, @builtin(instance_index) inst:u32)->Out {
  let id = f32(inst);
  let t = camera.time;
  let u1 = h1(id, 1.0);
  let u2 = h1(id, 2.0);
  let u3 = h1(id, 3.0);
  let isco = uniforms.isco * 0.5;

  var worldPos = vec3f(0.0);
  var velDir = vec3f(0.0, 0.0, 1.0);
  var baseTemp = 1.0;

  if (u3 < 0.88) {
    let radial = isco * 1.05 + pow(u1, 1.65) * 9.2;
    let omega = 1.0 / (pow(radial, 1.5) + uniforms.spin * 0.5);
    let angle = u2 * 6.2831853 + omega * t * 3.8;
    let tilt = 0.06 * uniforms.spin * (isco / radial) * sin(angle * 2.0 + id);
    let height = (h1(id, 4.0) - 0.5) * (0.05 + 0.14 * (radial / 10.0)) + radial * tilt;
    worldPos = vec3f(cos(angle) * radial, height, sin(angle) * radial);
    velDir = normalize(vec3f(-sin(angle), 0.0, cos(angle)));
    baseTemp = pow(isco / radial, 0.55) * uniforms.accretion;
  } else {
    let side = select(-1.0, 1.0, u3 > 0.94);
    let jetProgress = fract(u1 + t * (0.26 + 0.22 * uniforms.spin));
    let y = side * (1.1 + jetProgress * 8.5);
    let jetR = 0.18 + 0.48 * sqrt(jetProgress);
    let twist = u2 * 6.2831853 + t * (3.0 + 2.4 * uniforms.spin) - jetProgress * 5.0;
    worldPos = vec3f(cos(twist) * jetR, y, sin(twist) * jetR);
    velDir = normalize(vec3f(-sin(twist) * 0.35, side * 0.94, cos(twist) * 0.35));
    baseTemp = (1.4 - 0.7 * jetProgress) * (0.55 + 0.65 * uniforms.spin) * uniforms.accretion;
  }

  // Hide knots that lie behind the black hole shadow sphere from the camera's viewpoint
  let camDist2 = dot(camera.position, camera.position);
  let toKnot = worldPos - camera.position;
  let rayDir = normalize(toKnot);
  let b2 = length(cross(camera.position, rayDir));
  let behindHole = step(camDist2, dot(toKnot, toKnot)) * step(b2, 2.45);

  let toCam = -rayDir;
  let doppler = clamp(1.0 + 0.65 * dot(velDir, toCam), 0.42, 1.85);
  let c = mix(vec3f(1.0, 0.34, 0.1), vec3f(0.52, 0.8, 1.0), clamp((baseTemp * doppler - 0.45) * 0.78, 0.0, 1.0));

  let corner = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(1,1), vec2f(-1,-1), vec2f(1,1), vec2f(-1,1))[v];
  let view = camera.view;
  let right = vec3f(view[0][0], view[1][0], view[2][0]);
  let up = vec3f(view[0][1], view[1][1], view[2][1]);
  let size = (0.016 + 0.024 * h1(id, 5.0)) * (1.0 - behindHole);
  let offset = (right * corner.x + up * corner.y) * size;
  let pulse = 0.6 + 0.4 * sin(t * 2.4 + id * 1.7);
  return Out(
    camera.viewProjection * vec4f(worldPos + offset, 1.0),
    corner,
    c * pow(doppler, 2.0) * pulse * 0.95 * (1.0 - behindHole)
  );
}

@fragment fn fragment(i:Out)->@location(0) vec4f {
  let falloff = exp(-dot(i.uv, i.uv) * 4.2);
  return margoDisplay(vec4f(i.col * falloff, 0.0));
}
`;

// Exact Bardeen, Press & Teukolsky (1972) prograde ISCO and photon-sphere radii in units of gravitational radius r_g = GM/c^2.
function progradeISCO(a: number): number {
  const s = Math.min(Math.max(a, 0), 0.998);
  const z1 = 1 + Math.cbrt(1 - s * s) * (Math.cbrt(1 + s) + Math.cbrt(1 - s));
  const z2 = Math.sqrt(3 * s * s + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

function progradePhotonRing(a: number): number {
  const s = Math.min(Math.max(a, 0), 0.998);
  return 2 * (1 + Math.cos((2 / 3) * Math.acos(-s)));
}

const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  autoStart: false,
  label: 'A spinning relativistic black hole with gravitational lensing and orbiting plasma knots',
  camera: { position: [0, 2.35, 14.2], target: [0, -0.1, 0], fov: 44, far: 120 },
  onError: (value) => {
    document.querySelector('#error')!.textContent = String(value);
  },
});
paceEngine(stage.engine);
Bloom.attach(stage.engine, { strength: 0.24, threshold: 1.05, exposure: 0 });

const makeUniforms = () => ({
  spin: { value: 0.75 },
  accretion: { value: 1.15 },
  isco: { value: progradeISCO(0.75) },
  rPh: { value: progradePhotonRing(0.75) },
  flareAge: { value: -1 },
});

const horizonMat = new RawShaderMaterial({
  vertexShader: horizonShader,
  uniforms: makeUniforms(),
  depthTest: false,
  depthWrite: false,
  cull: 'none',
  name: 'event-horizon-field',
});

const knotsMat = new RawShaderMaterial({
  vertexShader: knotsShader,
  uniforms: makeUniforms(),
  transparent: true,
  blending: 'additive',
  depthTest: false,
  depthWrite: false,
  cull: 'none',
  name: 'event-horizon-knots',
});

const raw = RawShaders.attach(stage.engine);
raw.add(new RawMesh({ material: horizonMat, vertexCount: 3 }));
raw.add(new RawMesh({ material: knotsMat, vertexCount: 6, instanceCount: 4500 }));

const controls = new OrbitControls(stage.engine.camera, stage.canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 5.5;
controls.maxDistance = 24;
controls.minPolarAngle = 0.25;
controls.maxPolarAngle = Math.PI - 0.25;

const spinInput = document.querySelector<HTMLInputElement>('#spin')!,
  spinOut = document.querySelector<HTMLOutputElement>('#spin-out')!,
  accretionInput = document.querySelector<HTMLInputElement>('#accretion')!,
  accretionOut = document.querySelector<HTMLOutputElement>('#accretion-out')!,
  flareButton = document.querySelector<HTMLButtonElement>('#flare')!,
  telemetry = document.querySelector<HTMLElement>('#telemetry')!;

let flareAge = 1.4; // Start with an active spiral tidal stream

function syncParameters() {
  const a = Number(spinInput.value),
    mdot = Number(accretionInput.value),
    isco = progradeISCO(a),
    rPh = progradePhotonRing(a),
    betaMax = Math.min(Math.sqrt(1 / Math.max(isco - 0.35 * a, 0.85)), 0.78),
    dopplerMax = Math.sqrt((1 + betaMax) / (1 - betaMax));

  spinOut.value = a.toFixed(2);
  accretionOut.value = mdot.toFixed(2);
  telemetry.textContent = `r_ISCO ${isco.toFixed(2)} r_g · r_ph ${rPh.toFixed(2)} r_g · D_max ${dopplerMax.toFixed(2)}×`;

  for (const mat of [horizonMat, knotsMat]) {
    mat.uniforms.spin.value = a;
    mat.uniforms.accretion.value = mdot;
    mat.uniforms.isco.value = isco;
    mat.uniforms.rPh.value = rPh;
  }
}

spinInput.addEventListener('input', syncParameters);
accretionInput.addEventListener('input', syncParameters);
flareButton.addEventListener('click', () => {
  flareAge = 0;
});
document.querySelector('#form')!.addEventListener('submit', (event) => event.preventDefault());
syncParameters();

stage.use({
  name: 'event-horizon-loop',
  setup() {},
  onPreUpdate(delta) {
    controls.update(delta);
    if (raw.stats.drawCalls > 0 && raw.stats.pending === 0) document.querySelector('#status')?.remove();
    if (flareAge >= 0) {
      flareAge += delta;
      if (flareAge > 12) flareAge = -1;
    }
    horizonMat.uniforms.flareAge.value = flareAge;
    knotsMat.uniforms.flareAge.value = flareAge;
  },
  dispose: () => controls.dispose(),
});

stage.engine.start();
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
