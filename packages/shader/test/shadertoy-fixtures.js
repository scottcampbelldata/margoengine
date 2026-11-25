// Shadertoy Image sources for test/shadertoy-check.mjs: each runs through @margoengine/shader/shadertoy as a pass, as
// a texture and as a mesh material, and as the same wrapped GLSL in the browser's own WebGL2 (the oracle). Original
// programs; every documented input is read at injected values, never the wall clock.
/** Texel data: 8 x 8 2D, 4 x 4 cube faces and a 4 x 4 x 4 volume, rgba8, rows from the top. */
export function texels(kind) {
  const n = kind === '2d' ? 8 * 8 : kind === 'cube' ? 6 * 4 * 4 : 4 * 4 * 4,
    out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = i % (kind === '2d' ? 8 : 4),
      y = Math.floor(i / (kind === '2d' ? 8 : 4)) % (kind === '2d' ? 8 : 4),
      z = Math.floor(i / (kind === '2d' ? 64 : 16));
    out.set([(x * 37 + z * 50) % 256, (y * 71 + z * 23) % 256, (x * y * 13 + z * 41 + 30) % 256, 255], i * 4);
  }
  return out;
}
/** The inputs at the first draw (1) and after a live change (2). */
export const inputs = [
  { time: 1.25, frame: 7, timeDelta: 1 / 60, frameRate: 60, mouse: [10, 20, 5, 6], date: [2026, 10, 15, 43200.5] },
  { time: 3.7, frame: 12, timeDelta: 1 / 30, frameRate: 30, mouse: [3, 9, 1, 2], date: [2027, 0, 1, 100] },
];
export const toyFixtures = [
  {
    name: 'every documented input',
    channels: { iChannel0: { kind: '2d' }, iChannel1: { kind: '3d' } },
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  int cell = int(floor(uv.x * 4.0)) + 4 * int(floor(uv.y * 4.0));
  vec4 c = vec4(uv, 0.5 + 0.5 * sin(iTime + fragCoord.x * 0.3), 1.0);
  if (cell == 0) c = vec4(fract(iTime), fract(iTime * 0.37), iTimeDelta * 10.0, 1.0);
  else if (cell == 1) c = vec4(float(iFrame) / 16.0, iFrameRate / 120.0, iSampleRate / 88200.0, 1.0);
  else if (cell == 2) c = iMouse / 32.0;
  else if (cell == 3) c = vec4(mod(iDate.x, 16.0) / 16.0, iDate.y / 12.0, iDate.z / 31.0, iDate.w / 86400.0);
  else if (cell == 4) c = vec4(iChannelResolution[0] / 16.0, 1.0);
  else if (cell == 5) c = vec4(iChannelResolution[1] / 16.0, 1.0);
  else if (cell == 6) c = vec4(iChannelTime[0], iChannelTime[3], iGlobalTime * 0.1, 1.0);
  else if (cell == 7) c = vec4(iResolution / 64.0, 1.0);
  fragColor = c;
}`,
  },
  {
    name: 'a 2D channel, linear and repeating',
    channels: { iChannel0: { kind: '2d', filter: 'linear', wrap: 'repeat' } },
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = texture(iChannel0, fragCoord / iResolution.xy * 1.5 - vec2(0.2, 0.35) + 0.05 * iTime);
}`,
  },
  {
    name: 'a 2D channel, nearest and clamped, with texelFetch',
    channels: { iChannel2: { kind: '2d', filter: 'nearest' } },
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = uv.x < 0.5 ? texture(iChannel2, uv * 1.4 - 0.2) : texelFetch(iChannel2, ivec2(fragCoord) / 4, 0) * 0.8;
}`,
  },
  {
    name: 'a cube channel, each face away from its seams',
    channels: { iChannel1: { kind: 'cube' } },
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy * vec2(3.0, 2.0);
  int face = int(uv.x) + 3 * int(uv.y);
  vec2 l = fract(uv) * 1.2 - 0.6;
  vec3 d = face == 0 ? vec3(1.0, l) : face == 1 ? vec3(-1.0, l) : face == 2 ? vec3(l.x, 1.0, l.y)
    : face == 3 ? vec3(l.x, -1.0, l.y) : face == 4 ? vec3(l, 1.0) : vec3(l, -1.0);
  fragColor = texture(iChannel1, d);
}`,
  },
  {
    name: 'a 3D channel',
    channels: { iChannel3: { kind: '3d' } },
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = texture(iChannel3, vec3(uv, fract(0.2 + iTime * 0.3)));
}`,
  },
  {
    name: "the stack's colour as a channel",
    pass: true,
    channels: { iChannel0: { kind: 'input' } },
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec3 c = texture(iChannel0, fragCoord / iResolution.xy).rgb;
  fragColor = vec4(mix(c, 1.0 - c, 0.5 + 0.5 * sin(iTime)), 1.0);
}`,
  },
];
/** Fake sound for an audio channel: a fixed spectrum and waveform, as an AnalyserNode's byte data. */
export const audio = {
  getByteFrequencyData(a) {
    for (let i = 0; i < a.length; i++) a[i] = (i * 7 + 20) % 256;
  },
  getByteTimeDomainData(a) {
    for (let i = 0; i < a.length; i++) a[i] = 128 + Math.round(100 * Math.sin(i / 9));
  },
  context: { currentTime: 2.5 },
};
/** Keys held at the draw: A (65) went down this frame, B (66) went down and up again, so both toggled. */
export const keyEvents = [
  ['keydown', 65],
  ['keydown', 66],
  ['keyup', 66],
];
/** Each key row from GL's lowest: down, pressed this frame, toggled. */
export const keyRows = () => {
  const rows = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
  rows[0][65] = 255;
  rows[1][65] = rows[1][66] = 255;
  rows[2][65] = rows[2][66] = 255;
  return rows;
};
/**
 * Multipass programs, drawn for `frames` frames (frame k at time k / 10) and compared after the last. Channels name a
 * buffer letter, 'keyboard', 'audio' or 'canvas' (a 2D canvas drawn by `paint`, read as a video), with its filter.
 */
export const multiFixtures = [
  {
    name: 'Common and Buffers A to D with feedback, every filter',
    frames: 8,
    common: `vec4 wave(vec2 p, float t) {
  return 0.5 + 0.5 * cos(vec4(p.x * 4.0 + t, p.y * 3.0 - t, (p.x + p.y) * 2.0, 0.0));
}
const float decay = 0.75;`,
    buffers: {
      A: {
        channels: {
          iChannel0: { kind: 'A', filter: 'linear', wrap: 'repeat' },
          iChannel1: { kind: 'B', filter: 'nearest' },
        },
        source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec4 last = texture(iChannel0, uv + vec2(0.25, -0.5) / iResolution.xy);
  fragColor = vec4(mix(wave(uv, iTime).rgb, last.rgb, decay) + 0.05 * texture(iChannel1, uv).rgb, last.a + 1.0);
}`,
      },
      B: {
        channels: { iChannel0: { kind: 'A', filter: 'nearest' } },
        source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec4 a = texture(iChannel0, fragCoord / iResolution.xy);
  fragColor = vec4(a.gbr * 0.9, -2.5 * a.a);
}`,
      },
      C: {
        channels: {
          iChannel0: { kind: 'A', filter: 'mipmap', wrap: 'repeat' },
          iChannel1: { kind: 'B', filter: 'linear' },
        },
        source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = 0.5 * texture(iChannel0, uv * 2.8) + 0.5 * vec4(texture(iChannel1, uv + 0.25 / iResolution.xy).rgb, 1.0);
}`,
      },
      D: {
        channels: { iChannel0: { kind: 'C', filter: 'linear' }, iChannel1: { kind: 'D', filter: 'linear' } },
        source: `vec4 fetch(sampler2D s, vec2 p) { return texture(s, p); }
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = 0.5 * fetch(iChannel0, uv * 0.75 + 0.125) + 0.45 * texture(iChannel1, uv.yx);
}`,
      },
    },
    image: {
      channels: {
        iChannel0: { kind: 'D', filter: 'linear' },
        iChannel1: { kind: 'A', filter: 'nearest' },
        iChannel2: { kind: 'B', filter: 'nearest' },
        iChannel3: { kind: 'C', filter: 'mipmap' },
      },
      source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec4 c;
  if (uv.x < 0.5 && uv.y < 0.5) c = texture(iChannel0, uv * 2.0);
  else if (uv.y < 0.5) c = vec4(texelFetch(iChannel1, ivec2(fragCoord), 0).rgb * 0.7, 1.0);
  else if (uv.x < 0.5) c = vec4(texture(iChannel2, uv).rgb, 0.5 + texture(iChannel2, uv).a / 40.0);
  else c = textureLod(iChannel3, uv, 1.5);
  vec4 b = texelFetch(iChannel2, ivec2(fragCoord), 0);
  fragColor = vec4(mix(c.rgb, vec3(-b.a / 40.0), 0.25), 1.0);
}`,
    },
  },
  {
    name: 'keyboard, audio and a canvas as video',
    frames: 1,
    image: {
      channels: {
        iChannel0: { kind: 'keyboard', filter: 'nearest' },
        iChannel1: { kind: 'audio', filter: 'linear' },
        iChannel2: { kind: 'canvas', filter: 'linear' },
        iChannel3: { kind: 'canvas', filter: 'mipmap' },
      },
      source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  int cell = int(floor(uv.x * 4.0)) + 4 * int(floor(uv.y * 4.0));
  vec4 c = vec4(0.1, 0.2, 0.3, 1.0);
  if (cell < 6) c = vec4(texelFetch(iChannel0, ivec2(65 + cell / 3, cell % 3), 0).xyz, 1.0);
  else if (cell == 6) c = vec4(iChannelTime[1] / 4.0, iChannelTime[2] / 4.0, iChannelResolution[0].x / 512.0, 1.0);
  else if (cell == 7) c = vec4(iChannelResolution[1].xy / 512.0, iChannelResolution[2].xy / 64.0);
  else if (cell < 12) c = vec4(texture(iChannel1, vec2(uv.x, 0.25)).x, texture(iChannel1, vec2(uv.x * 0.5, 0.75)).x, texture(iChannel1, uv).yz);
  else if (cell < 14) c = texture(iChannel2, uv * 1.3 - 0.1);
  else c = texture(iChannel3, uv * 3.0);
  fragColor = c;
}`,
    },
  },
];
/** The canvas a 'canvas' channel reads: 16 x 16, a smooth pattern, and a currentTime as a video has. */
export function paint(canvas) {
  canvas.width = canvas.height = 16;
  const g = canvas.getContext('2d'),
    image = g.createImageData(16, 16);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) image.data.set([x * 15, y * 15, ((x + y) * 8) % 256, 255], (y * 16 + x) * 4);
  g.putImageData(image, 0, 0);
  canvas.currentTime = 1.5;
  return canvas;
}
// Push 7 (Cube A, mainVR, mainSound). The image direction of the first Cube A fixture, as fixtureDir in its source:
// a longitude and latitude sweep that crosses all six faces.
export function cubeDirection(x, y, w, h) {
  const theta = (x / w) * 6.2831853,
    phi = (y / h - 0.5) * 3.0;
  return [Math.cos(phi) * Math.cos(theta), Math.sin(phi), Math.cos(phi) * Math.sin(theta)];
}
const fixtureDir = `vec3 fixtureDir(vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float theta = uv.x * 6.2831853, phi = (uv.y - 0.5) * 3.0;
  return vec3(cos(phi) * cos(theta), sin(phi), cos(phi) * sin(theta));
}`;
/** Cube A programs, run by the multipass check (frames, buffers, Common). `analytic`: the image is 0.5 + 0.5 x the direction. */
export const cubeFixtures = [
  {
    name: 'Cube A faces read back through a samplerCube',
    frames: 1,
    size: 64,
    analytic: true,
    common: fixtureDir,
    cubeA: {
      channels: {},
      source: `void mainCubemap(out vec4 fragColor, in vec2 fragCoord, in vec3 rayOri, in vec3 rayDir) {
  fragColor = vec4(rayDir + rayOri, 1.0);
}`,
    },
    image: {
      channels: { iChannel0: { kind: 'cubeA', filter: 'linear' } },
      source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(0.5 + 0.5 * texture(iChannel0, fixtureDir(fragCoord)).xyz, 1.0);
}`,
    },
  },
  {
    name: 'Cube A with feedback, Buffer A and mip levels',
    frames: 6,
    size: 16,
    common: fixtureDir,
    buffers: {
      A: {
        channels: { iChannel0: { kind: 'cubeA', filter: 'linear' } },
        source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  // Many texels of the cube under each pixel: a linear channel still reads the base level only.
  fragColor = vec4(texture(iChannel0, fixtureDir(fragCoord * vec2(5.0, 1.0))).rgb, uv.x);
}`,
      },
    },
    cubeA: {
      channels: { iChannel0: { kind: 'cubeA', filter: 'linear' }, iChannel1: { kind: 'A', filter: 'nearest' } },
      source: `void mainCubemap(out vec4 fragColor, in vec2 fragCoord, in vec3 rayOri, in vec3 rayDir) {
  vec3 last = texture(iChannel0, rayDir.yzx).rgb;
  vec4 a = texture(iChannel1, (fragCoord + 0.25) / iResolution.xy);
  fragColor = vec4(mix(0.5 + 0.5 * cos(rayDir * 3.0 + float(iFrame)), last, 0.6) * 0.8 + 0.2 * a.rgb, 1.0);
}`,
    },
    image: {
      channels: {
        iChannel0: { kind: 'cubeA', filter: 'mipmap' },
        iChannel1: { kind: 'A', filter: 'linear' },
        iChannel2: { kind: 'cubeA', filter: 'nearest' },
      },
      source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 d = fixtureDir(fragCoord);
  // Every implicit-derivative lookup runs in uniform control flow (GLSL ES 3.00 section 8.8), then one is chosen. The
  // footprint lookup stays inside the +X face: where a 2 x 2 quad spans two faces GL leaves the level to the GPU.
  vec3 level = textureLod(iChannel0, d, 1.5).rgb, footprint = texture(iChannel0, normalize(vec3(1.0, (uv - vec2(0.75, 0.5)) * 2.4))).rgb, buffer = texture(iChannel1, uv).rgb;
  vec3 near = texture(iChannel2, d.zxy).rgb + vec3(iChannelResolution[0].x, iChannelResolution[2].y, iChannelResolution[1].x) / 256.0;
  vec3 c = uv.y < 0.25 ? buffer : uv.y > 0.75 ? near : uv.x < 0.5 ? level : footprint;
  fragColor = vec4(c, 1.0);
}`,
    },
  },
];
/** A mainVR program drawn from two eyes; its rays meet the plane z = -1 behind the origin. */
export const vrFixture = {
  name: 'mainVR rays from a pair of eyes',
  eyes: [
    { position: [-0.032, 0.02, 2], target: [-0.06, 0.04, 0] },
    { position: [0.032, 0.02, 2], target: [0.09, -0.02, 0] },
  ],
  source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(fragCoord / iResolution.xy, 0.0, 1.0); }
void mainVR(out vec4 fragColor, in vec2 fragCoord, in vec3 fragRayOri, in vec3 fragRayDir) {
  float t = (-1.0 - fragRayOri.z) / fragRayDir.z;
  vec2 hit = fragRayOri.xy + t * fragRayDir.xy;
  vec3 c = 0.5 + 0.5 * fragRayDir * vec3(4.0, 4.0, 1.0);
  c *= 0.75 + 0.25 * sin(hit.x * 7.0) * cos(hit.y * 5.0);
  fragColor = vec4(c + vec3(fragRayOri.x, fragRayOri.y, 0.0) * 4.0, 1.0);
}`,
};
/** Sound tabs: samples against the same program in WebGL2 with RGBA32F targets. */
export const soundFixtures = [
  {
    name: 'mainSound(int samp, float time) over two blocks, clamped, with a texture',
    sampleRate: 8000,
    seconds: 40,
    channels: { iChannel0: { kind: '2d', filter: 'linear' } },
    source: `vec2 mainSound(int samp, float time) {
  float a = sin(6.2831853 * fract(440.0 * time)) * exp(-0.05 * time);
  float b = texture(iChannel0, vec2(fract(time * 0.5), 0.5)).r * 2.4 - 1.2;
  return vec2(a, float(samp % 1000) / 400.0 - 1.25 + b * 0.1);
}`,
  },
  {
    name: 'the older mainSound(float time)',
    sampleRate: 44100,
    seconds: 0.5,
    channels: {},
    source: `vec2 mainSound(float time) {
  return vec2(sin(6.2831853 * fract(220.0 * time)), 0.5 * cos(6.2831853 * fract(330.0 * time)));
}`,
  },
];
