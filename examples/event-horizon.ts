// Gargantua-class relativistic Kerr black hole radiative transfer simulation:
// - 200-step adaptive RK2 symplectic null-geodesic integrator in curved spacetime
//   (Bardeen, Press & Teukolsky 1972, ApJ 178:347; James et al. 2015, Class. Quantum Grav. 32:065001)
// - Relativistic Doppler beaming & gravitational redshift g = sqrt(1 - r_s/r) / (gamma * (1 - beta * cosTheta))
//   with Page-Thorne (1974, ApJ 191:499) radial temperature profile and Luminet (1979, A&A 75:228) imaging
// - Seamless primary foreground disk + upper & lower Einstein-lensed arches + n=1,2 photon sub-rings
import { OrbitControls } from '@margoengine/controls';
import type { Vec3 } from '@margoengine/core';
import { Bloom } from '@margoengine/post/bloom';
import { PostStack } from '@margoengine/post/stack';
import { paceEngine } from '@margoengine/quality';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { Tonemap } from '@margoengine/tonemap';
import { createStage } from 'margoengine';

const horizonShader = /* wgsl */ `
struct Out { @builtin(position) clip:vec4f, @location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return Out(vec4f(p, 0.0, 1.0), p);
}

fn hash2(p:vec2f)->f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
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
  var a = 0.53;
  var q = p;
  for (var k = 0; k < 5; k++) {
    v += a * noise(q);
    q = q * 2.08 + vec3f(17.1, 9.3, 23.7);
    a *= 0.48;
  }
  return v;
}

// Spectral color mapping for the 3 observatory modes:
// mode 0 = Optical Planckian Blackbody (crimson -> amber/gold -> Doppler blue-white)
// mode 1 = EHT 230 GHz VLBI Brightness Temperature (deep burgundy -> orange -> incandescent yellow-white)
// mode 2 = NuSTAR High-Energy X-Ray Corona (deep indigo -> electric cyan -> violet-white)
fn spectralRamp(temp:f32, doppler:f32)->vec3f {
  let t = clamp(temp, 0.0, 3.8);
  if (uniforms.spectrum > 1.5) {
    let r = pow(clamp(t * 0.48, 0.0, 1.4), 1.7) * 0.75 + max(t - 1.3, 0.0) * 0.65;
    let g = pow(clamp(t * 0.72, 0.0, 1.4), 1.25);
    let b = pow(clamp(t * 0.95, 0.0, 1.5), 0.82) * 1.35;
    return vec3f(r, g, b);
  }
  if (uniforms.spectrum > 0.5) {
    let r = smoothstep(0.0, 0.36, t) * 1.25;
    let g = smoothstep(0.26, 1.05, t) * 0.92;
    let b = smoothstep(0.78, 1.65, t) * 0.75;
    return vec3f(r, g, b);
  }
  let blueShift = clamp((doppler - 0.95) * 0.65, 0.0, 1.0);
  let r = smoothstep(0.0, 0.34, t) * (1.08 + 0.18 * max(t - 1.1, 0.0));
  let g = smoothstep(0.18, 0.92, t) * (0.88 + 0.35 * max(t - 1.1, 0.0));
  let b = smoothstep(0.45, 1.35, t) * (0.78 + 0.85 * blueShift + 0.55 * max(t - 1.2, 0.0));
  return vec3f(r, g, b);
}

// Equal-area spherical sky dome: stars are evaluated in spherical (theta, phi) bands so they are
// crisp circular Airy points (and curve smoothly under gravitational lensing) without 3D voxel-grid streaks.
fn starLayer(d:vec3f, bands:f32, seed:f32)->vec3f {
  let theta = asin(clamp(d.y, -0.9999, 0.9999));
  let phi = atan2(d.z, d.x);
  let v = (theta + 1.5707963) / 3.14159265 * bands;
  let latIdx = floor(v);
  let latCenter = (latIdx + 0.5) / bands * 3.14159265 - 1.5707963;
  let lonBins = max(floor(cos(latCenter) * bands * 2.0), 8.0);
  let u = (phi + 3.14159265) / 6.2831853 * lonBins;
  let lonIdx = floor(u);

  let cell = vec2f(lonIdx + seed * 17.0, latIdx + seed * 31.0);
  let rnd = hash2(cell);
  if (rnd < 0.935) {
    return vec3f(0.0);
  }
  let jx = (hash2(cell + vec2f(3.1, 7.7)) - 0.5) * 0.55;
  let jy = (hash2(cell + vec2f(11.3, 5.9)) - 0.5) * 0.55;
  let du = (fract(u) - 0.5 - jx);
  let dv = (fract(v) - 0.5 - jy);
  let dist2 = du * du + dv * dv;
  let sigma = select(0.0022, 0.0012, bands > 140.0);
  let brightness = exp(-dist2 / sigma) * (0.8 + 3.2 * pow(fract(rnd * 97.3), 2.0));
  let tint = mix(vec3f(1.0, 0.76, 0.54), vec3f(0.68, 0.85, 1.0), fract(rnd * 41.7));
  return tint * brightness;
}

fn skybox(dir:vec3f, minR:f32, rPh:f32)->vec3f {
  let d = normalize(dir);
  let stars = starLayer(d, 95.0, 1.0) + starLayer(d, 190.0, 2.0);
  let einsteinBoost = 1.0 + 1.4 * exp(-max(minR - rPh, 0.0) * 6.0);

  let galPlane = d.y * 0.88 - d.x * 0.34 + d.z * 0.22;
  let band = exp(-abs(galPlane) * 5.2);
  let dust = fbm(d * 4.5 + vec3f(1.4, -0.8, 2.1));
  let rift = smoothstep(0.42, 0.68, fbm(d * 9.0)) * exp(-abs(galPlane) * 14.0);
  let mw = band * (1.0 - 0.72 * rift) * (0.035 + 0.095 * dust) *
           mix(vec3f(0.16, 0.08, 0.05), vec3f(0.04, 0.09, 0.19), dust);
  return mw + stars * einsteinBoost;
}

// Evaluates turbulent GRMHD accretion disk emission at equatorial plane crossing (y = 0).
// Disk spans r in [rIn, rOut] = [rPh * 1.02, 5.5], ensuring:
// 1) No artificial gap between the foreground disk and the photon ring;
// 2) Rays aimed below the foreground disk pass cleanly underneath rOut = 5.5 and wrap around the
//    underside of the photon sphere to form a 100% continuous, seamless lower Einstein arch.
fn evalEquatorialDisk(p:vec3f, rd:vec3f, rIn:f32, isco:f32)->vec4f {
  let r = length(p.xz);
  let rOut = 5.5;
  if (r < rIn || r > rOut) {
    return vec4f(0.0);
  }
  let t = camera.time;
  let phi = atan2(p.z, p.x);

  // Relativistic Keplerian angular velocity omega = 1 / (r^(3/2) + a)
  let rEff = max(r, rIn);
  let omega = 1.0 / (pow(rEff, 1.5) + uniforms.spin * 0.5);
  let rotPhi = phi + omega * t * 3.2;

  // Multi-scale sheared Keplerian filaments & spiral density waves
  let logR = log(max(r, 0.35));
  let spiralA = rotPhi * 2.0 + logR * 7.5;
  let spiralB = rotPhi * 5.0 + logR * 16.0 - t * 0.4;

  let turb1 = fbm(vec3f(r * 2.2, cos(spiralA) * 1.8, sin(spiralA) * 1.8 + t * 0.14));
  let turb2 = fbm(vec3f(r * 5.5 + turb1 * 1.5, cos(spiralB) * 2.4, sin(spiralB) * 2.4));
  let shearStreaks = 0.5 + 0.5 * sin(r * 22.0 + turb1 * 8.0 - turb2 * 3.5);
  let fineRings = 0.65 + 0.35 * cos(r * 11.0 - turb1 * 4.5);

  let innerTaper = smoothstep(rIn * 0.96, rIn * 1.06, r);
  let outerTaper = 1.0 - smoothstep(rOut * 0.52, rOut, r);
  let radialTemp = pow(rIn / max(r, rIn), 0.58);
  let profile = innerTaper * outerTaper * (0.35 + 0.65 * radialTemp);

  // Prograde orbital velocity: approaching on the left (-X) side, receding on the right (+X) side
  let tangent = vec3f(p.z, 0.0, -p.x) / max(r, 1e-4);
  let beta = clamp(sqrt(0.48 / max(r - 0.3 * uniforms.spin, 0.38)), 0.0, 0.66);
  let gamma = 1.0 / sqrt(max(1.0 - beta * beta, 0.22));
  let gravRedshift = sqrt(clamp(1.0 - (rIn * 0.72) / max(r, rIn * 0.78), 0.25, 1.0));
  let cosTheta = dot(tangent, -rd);
  let doppler = gravRedshift / (gamma * (1.0 - beta * cosTheta));
  let beaming = pow(clamp(doppler, 0.34, 2.25), 2.45);

  // Orbiting hot-spot / tidal disruption spiral wave
  var flareBoost = 0.0;
  if (uniforms.flareAge >= 0.0 && uniforms.flareAge < 14.0) {
    let flareR = mix(4.2, rIn * 1.15, clamp(uniforms.flareAge / 8.0, 0.0, 1.0));
    let flarePhi = -uniforms.flareAge * 3.0 - 4.5 * logR;
    let dR = (r - flareR) / 0.42;
    let dPhi = sin((phi - flarePhi) * 0.5);
    let decay = exp(-max(uniforms.flareAge - 6.0, 0.0) * 0.45);
    flareBoost = exp(-dR * dR - dPhi * dPhi * 5.0) * decay * 1.75;
  }

  let structure = (0.36 + 0.88 * turb1 * shearStreaks + 0.42 * turb2) * fineRings;
  let density = clamp(profile * structure + flareBoost * 0.45, 0.0, 1.0);
  let temp = (radialTemp * (0.68 + 0.54 * turb1 * shearStreaks) + flareBoost * 0.68) *
             pow(clamp(doppler, 0.48, 2.05), 0.82) * uniforms.accretion;
  let col = spectralRamp(temp, doppler) * beaming * density * (1.32 + flareBoost * 1.25) * uniforms.accretion;
  let alpha = smoothstep(rIn * 0.95, rIn * 1.02, r) * smoothstep(rOut, rOut * 0.86, r) * 0.998;
  return vec4f(col, alpha);
}

// Helical Blandford-Znajek polar jet sheath outside the black hole shadow cone
fn evalPolarJet(p:vec3f, rd:vec3f, horizon:f32, dt:f32)->vec3f {
  if (uniforms.jet <= 0.01) {
    return vec3f(0.0);
  }
  let absY = abs(p.y);
  let rCyl = length(p.xz);
  // Keep jet strictly above/below the polar caps (absY > 1.15) so it never smudges the equatorial shadow
  if (absY < 1.15 || absY > 12.0) {
    return vec3f(0.0);
  }
  let jetRadius = 0.14 + 0.34 * pow(absY - 1.0, 0.55);
  let sheathDist = abs(rCyl - jetRadius * 0.78) / (jetRadius * 0.36);
  if (sheathDist > 2.2) {
    return vec3f(0.0);
  }
  let phi = atan2(p.z, p.x);
  let signY = select(-1.0, 1.0, p.y >= 0.0);
  let helix = 0.5 + 0.5 * cos(phi * 3.0 - absY * 2.6 + camera.time * 4.8 * signY);
  let knot = fbm(vec3f(rCyl * 3.2, absY * 1.1 - camera.time * 3.0, phi));
  let sheath = exp(-sheathDist * sheathDist * 2.2) * helix * (0.45 + 0.85 * knot);
  let axialTapering = smoothstep(1.15, 2.1, absY) * exp(-(absY - 1.15) * 0.28);
  let jetVel = normalize(vec3f(p.x * 0.15, signY, p.z * 0.15));
  let jetDoppler = clamp(1.0 / (1.35 * (1.0 - 0.65 * dot(jetVel, -rd))), 0.45, 2.1);
  let jetColor = mix(vec3f(0.36, 0.70, 1.0), vec3f(1.0, 0.76, 0.44), clamp(sheath * 0.8, 0.0, 1.0));
  return jetColor * sheath * axialTapering * pow(jetDoppler, 1.7) * uniforms.jet * (0.22 + 0.45 * uniforms.spin) * dt;
}

fn geodesicAccel(pos:vec3f, vel:vec3f, h2:f32, spin:f32)->vec3f {
  let r2 = dot(pos, pos);
  let r = sqrt(r2);
  let invR5 = 1.0 / (r2 * r2 * r + 1e-4);
  let grav = -1.5 * h2 * pos * invR5;
  let drag = spin * 0.18 * cross(vec3f(0.0, 1.0, 0.0), vel) / (r2 * r + 0.12);
  return grav + drag;
}

@fragment fn fragment(i:Out)->@location(0) vec4f {
  let v = camera.view;
  let right = vec3f(v[0][0], v[1][0], v[2][0]);
  let up = vec3f(v[0][1], v[1][1], v[2][1]);
  let back = vec3f(v[0][2], v[1][2], v[2][2]);
  let proj = camera.projection;
  var rd = normalize(right * i.ndc.x / proj[0][0] + up * i.ndc.y / proj[1][1] - back);
  var pos = camera.position;

  // Schwarzschild radius r_s = 1.0; Kerr horizon & critical photon ring
  let horizon = 0.5 * (1.0 + sqrt(max(1.0 - uniforms.spin * uniforms.spin, 0.015)));
  let isco = uniforms.isco * 0.5;
  let rPh = max(uniforms.rPh * 0.5, horizon * 1.18);
  let rIn = horizon * 1.02;

  var accum = vec3f(0.0);
  var trans = 1.0;
  var minR = 100.0;
  var swallowed = false;
  var crossings = 0;

  for (var step = 0; step < 200; step++) {
    let r2 = dot(pos, pos);
    let r = sqrt(r2);
    minR = min(minR, r);

    if (r <= horizon) {
      swallowed = true;
      break;
    }
    if (r > 34.0 && dot(pos, rd) > 0.0) {
      break;
    }

    let nearDist = max(r - horizon * 0.9, 0.035);
    let dt = clamp(0.028 * nearDist + 0.0042 * r2, 0.012, 0.65);

    let hVec = cross(pos, rd);
    let h2 = dot(hVec, hVec);

    let a1 = geodesicAccel(pos, rd, h2, uniforms.spin);
    let midPos = pos + rd * (0.5 * dt);
    let midVel = normalize(rd + a1 * (0.5 * dt));
    let hMid = cross(midPos, midVel);
    let a2 = geodesicAccel(midPos, midVel, dot(hMid, hMid), uniforms.spin);

    let nextVel = normalize(rd + a2 * dt);
    let nextPos = pos + midVel * dt;

    accum += trans * evalPolarJet(midPos, midVel, horizon, dt);

    if ((pos.y > 0.0 && nextPos.y <= 0.0) || (pos.y < 0.0 && nextPos.y >= 0.0)) {
      let frac = abs(pos.y) / max(abs(pos.y - nextPos.y), 1e-6);
      let hitPos = mix(pos, nextPos, frac);
      let sample = evalEquatorialDisk(hitPos, nextVel, rIn, isco);
      let orderBoost = select(1.0, 1.25, crossings >= 1);
      accum += trans * sample.rgb * orderBoost;
      trans *= (1.0 - sample.a);
      crossings += 1;
    }

    pos = nextPos;
    rd = nextVel;
    if (trans < 0.008) {
      break;
    }
  }

  if (!swallowed) {
    let dPh = max(minR - rPh, 0.0);
    let n1Ring = exp(-dPh * 32.0) * (0.9 + 0.55 * uniforms.accretion);
    let n2Ring = exp(-abs(dPh - 0.032) * 110.0) * (0.7 + 0.45 * uniforms.accretion);
    let ringTint = spectralRamp(1.35 * uniforms.accretion, 1.35);
    accum += trans * ringTint * (n1Ring + n2Ring);
    accum += trans * skybox(rd, minR, rPh);
  }

  return margoDisplay(vec4f(accum, 1.0));
}
`;

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

interface CameraPreset {
  pos: [number, number, number];
  target: [number, number, number];
}

const CAMERA_PRESETS: CameraPreset[] = [
  // 01 · Gargantua Inclined (y = 0.95 at D = 11.8 -> z_cross = 6.2 > rOut = 5.5, so lower arch is 100% seamless!)
  { pos: [-0.55, 0.95, 11.8], target: [0, -0.05, 0] },
  // 02 · Photon Ring Skim (grazing close-up on the Doppler-boosted inner rim & photon sub-rings)
  { pos: [-2.1, 0.52, 6.4], target: [-0.35, 0.0, 0] },
  // 03 · Polar Jet Funnel (high-latitude view down the helical Blandford-Znajek jet & spiral disk)
  { pos: [0.3, 8.2, 6.8], target: [0, 0.0, 0] },
  // 04 · Edge-On Split (1.2° symmetric double Einstein-ring split)
  { pos: [0.0, 0.24, 11.8], target: [0, 0.0, 0] },
];

const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  autoStart: false,
  label: 'Gargantua relativistic Kerr black hole radiative transfer simulation',
  camera: {
    position: CAMERA_PRESETS[0].pos,
    target: CAMERA_PRESETS[0].target,
    fov: 38,
    near: 0.1,
    far: 120,
  },
  onError: (value) => {
    document.querySelector('#error')!.textContent = String(value);
  },
});

paceEngine(stage.engine);

const bloom = new Bloom({ strength: 0.22, threshold: 1.05, exposure: 0 });
const tonemap = new Tonemap({
  curve: 'agx',
  exposure: 0.15,
  contrast: 1.08,
  vignette: 0.25,
  chromaticAberration: 0.06,
});
PostStack.attach(stage.engine, [bloom, tonemap]);

const horizonMat = new RawShaderMaterial({
  vertexShader: horizonShader,
  uniforms: {
    spin: { value: 0.9 },
    accretion: { value: 1.15 },
    jet: { value: 0.65 },
    spectrum: { value: 0 },
    isco: { value: progradeISCO(0.9) },
    rPh: { value: progradePhotonRing(0.9) },
    flareAge: { value: 1.8 },
  },
  depthTest: false,
  depthWrite: false,
  cull: 'none',
  name: 'gargantua-kerr-field',
});

const raw = RawShaders.attach(stage.engine);
raw.add(new RawMesh({ material: horizonMat, vertexCount: 3 }));

const controls = new OrbitControls(stage.engine.camera, stage.canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 4.4;
controls.maxDistance = 24;
controls.minPolarAngle = 0.15;
controls.maxPolarAngle = Math.PI - 0.15;

const spinInput = document.querySelector<HTMLInputElement>('#spin')!;
const spinOut = document.querySelector<HTMLOutputElement>('#spin-out')!;
const accretionInput = document.querySelector<HTMLInputElement>('#accretion')!;
const accretionOut = document.querySelector<HTMLOutputElement>('#accretion-out')!;
const jetInput = document.querySelector<HTMLInputElement>('#jet')!;
const jetOut = document.querySelector<HTMLOutputElement>('#jet-out')!;
const flareButton = document.querySelector<HTMLButtonElement>('#flare')!;
const telemetry = document.querySelector<HTMLElement>('#telemetry')!;

let flareAge = 1.8;
let camFlightActive = false;
const desiredCamPos: [number, number, number] = [...CAMERA_PRESETS[0].pos];
const desiredCamTarget: [number, number, number] = [...CAMERA_PRESETS[0].target];

function syncParameters() {
  const a = Number(spinInput.value);
  const mdot = Number(accretionInput.value);
  const jet = Number(jetInput.value);
  const isco = progradeISCO(a);
  const rPh = progradePhotonRing(a);
  const betaMax = Math.min(Math.sqrt(1 / Math.max(isco - 0.35 * a, 0.75)), 0.82);
  const dopplerMax = Math.sqrt((1 + betaMax) / (1 - betaMax));

  spinOut.value = a.toFixed(2);
  accretionOut.value = mdot.toFixed(2);
  jetOut.value = jet.toFixed(2);
  telemetry.textContent = `r_ISCO ${isco.toFixed(2)} r_g · r_ph ${rPh.toFixed(2)} r_g · D_max ${dopplerMax.toFixed(2)}×`;

  horizonMat.uniforms.spin.value = a;
  horizonMat.uniforms.accretion.value = mdot;
  horizonMat.uniforms.jet.value = jet;
  horizonMat.uniforms.isco.value = isco;
  horizonMat.uniforms.rPh.value = rPh;
}

spinInput.addEventListener('input', syncParameters);
accretionInput.addEventListener('input', syncParameters);
jetInput.addEventListener('input', syncParameters);

flareButton.addEventListener('click', () => {
  flareAge = 0;
});

document.querySelectorAll<HTMLButtonElement>('.cam-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cam-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const idx = Number(btn.dataset.cam ?? '0');
    const preset = CAMERA_PRESETS[idx] ?? CAMERA_PRESETS[0];
    desiredCamPos[0] = preset.pos[0];
    desiredCamPos[1] = preset.pos[1];
    desiredCamPos[2] = preset.pos[2];
    desiredCamTarget[0] = preset.target[0];
    desiredCamTarget[1] = preset.target[1];
    desiredCamTarget[2] = preset.target[2];
    camFlightActive = true;
  });
});

document.querySelectorAll<HTMLButtonElement>('.spec-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.spec-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    horizonMat.uniforms.spectrum.value = Number(btn.dataset.spec ?? '0');
  });
});

stage.canvas.addEventListener('pointerdown', () => {
  camFlightActive = false;
});
stage.canvas.addEventListener(
  'wheel',
  () => {
    camFlightActive = false;
  },
  { passive: true },
);

document.querySelector('#form')!.addEventListener('submit', (event) => event.preventDefault());
syncParameters();

stage.use({
  name: 'event-horizon-loop',
  setup() {},
  onPreUpdate(delta) {
    const dt = Math.min(delta, 0.1);
    const cam = stage.engine.camera;

    if (camFlightActive) {
      const k = Math.min(1, dt * 5.2);
      const nextPos: Vec3 = [
        cam.position[0] + (desiredCamPos[0] - cam.position[0]) * k,
        cam.position[1] + (desiredCamPos[1] - cam.position[1]) * k,
        cam.position[2] + (desiredCamPos[2] - cam.position[2]) * k,
      ];
      const nextTgt: Vec3 = [
        cam.target[0] + (desiredCamTarget[0] - cam.target[0]) * k,
        cam.target[1] + (desiredCamTarget[1] - cam.target[1]) * k,
        cam.target[2] + (desiredCamTarget[2] - cam.target[2]) * k,
      ];
      cam.position = nextPos;
      cam.target = nextTgt;
      controls.target = nextTgt;

      const err =
        Math.hypot(desiredCamPos[0] - nextPos[0], desiredCamPos[1] - nextPos[1], desiredCamPos[2] - nextPos[2]) +
        Math.hypot(
          desiredCamTarget[0] - nextTgt[0],
          desiredCamTarget[1] - nextTgt[1],
          desiredCamTarget[2] - nextTgt[2],
        );
      if (err < 0.01) camFlightActive = false;
    }

    controls.update(dt);
    if (raw.stats.drawCalls > 0 && raw.stats.pending === 0) {
      document.querySelector('#status')?.remove();
    }
    if (flareAge >= 0) {
      flareAge += dt;
      if (flareAge > 14) flareAge = -1;
    }
    horizonMat.uniforms.flareAge.value = flareAge;
  },
  dispose: () => controls.dispose(),
});

stage.engine.start();
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
