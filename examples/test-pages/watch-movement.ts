import { ready } from './page-harness';
import { OrbitControls } from '@margoengine/controls';
import type { Mesh, Vec3 } from '@margoengine/core';
import { Environment, EnvironmentLighting } from '@margoengine/environment';
import { createMesh, type MaterialMesh, type MeshGeometry, PbrMaterial, Texture } from '@margoengine/materials';
import { Bloom } from '@margoengine/post/bloom';
import { SSAO } from '@margoengine/post/ssao';
import { PostStack } from '@margoengine/post/stack';
import { paceEngine } from '@margoengine/quality';
import { Picking, Selection } from '@margoengine/selection';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { ContactShadows } from '@margoengine/studio';
import { Tonemap } from '@margoengine/tonemap';
import { createStage } from 'margoengine';

// ============================================================================
// 1. 100% PROCEDURAL HDR STUDIO ENVIRONMENT & 512 PX MACHINED NORMAL MAPS
// ============================================================================

function createProceduralStudioHDR(width = 256, height = 128) {
  const data = new Float32Array(width * height * 4);
  const softbox = (u: number, v: number, cu: number, cv: number, rx: number, ry: number) =>
    Math.exp(-(((u - cu) / rx) ** 2 + ((v - cv) / ry) ** 2));

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const sky = v < 0.5 ? 0.28 + 0.55 * (0.5 - v) : 0.14 * (1 - (v - 0.5) * 1.6);
      const key = 11.0 * softbox(u, v, 0.26, 0.22, 0.08, 0.07);
      const rim = 7.5 * softbox(u, v, 0.76, 0.28, 0.09, 0.06);
      const strip = 4.2 * softbox(u, v, 0.52, 0.14, 0.22, 0.035);
      const idx = (y * width + x) * 4;
      data[idx] = sky * 0.9 + key * 1.04 + rim * 0.65 + strip;
      data[idx + 1] = sky * 0.95 + key * 0.96 + rim * 0.88 + strip * 0.96;
      data[idx + 2] = sky * 1.1 + key * 0.84 + rim * 1.18 + strip * 0.92;
      data[idx + 3] = 1.0;
    }
  }
  return { width, height, data };
}

function createGenevaStripesNormalMap(size = 512): Texture {
  const data = new Uint8Array(size * size * 4);
  const stripes = 14;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const phase = u * stripes * Math.PI * 2;
      const rib = Math.cos(phase) * 0.35;
      const brush = Math.sin((v * 180 + Math.sin(u * 40) * 2) * Math.PI * 2) * 0.12;
      const nx = Math.max(-1, Math.min(1, rib + brush * 0.25));
      const ny = Math.max(-1, Math.min(1, brush));
      const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
      const idx = (y * size + x) * 4;
      data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }
  return new Texture({ data, width: size, height: size }, { colorSpace: 'linear', mipmaps: true });
}

function createRadialBrushedNormalMap(size = 512): Texture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const py = (y / size - 0.5) * 2;
    for (let x = 0; x < size; x++) {
      const px = (x / size - 0.5) * 2;
      const r = Math.hypot(px, py) + 1e-5;
      const angle = Math.atan2(py, px);
      const concentric = Math.sin(r * 220) * 0.22 + Math.sin(r * 65) * 0.1;
      const radial = Math.sin(angle * 96) * 0.08;
      const nx = Math.max(-1, Math.min(1, (px / r) * concentric - (py / r) * radial));
      const ny = Math.max(-1, Math.min(1, (py / r) * concentric + (px / r) * radial));
      const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
      const idx = (y * size + x) * 4;
      data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }
  return new Texture({ data, width: size, height: size }, { colorSpace: 'linear', mipmaps: true });
}

// ============================================================================
// 2. PROCEDURAL CNC HOROLOGICAL GEOMETRY BUILDERS (INVOLUTE GEARS & BRIDGES)
// ============================================================================

class GeometryBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];

  addVertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const idx = this.positions.length / 3;
    this.positions.push(px, py, pz);
    const len = Math.hypot(nx, ny, nz) || 1;
    this.normals.push(nx / len, ny / len, nz / len);
    this.uvs.push(u, v);
    return idx;
  }

  addQuad(a: number, b: number, c: number, d: number) {
    this.indices.push(a, b, c, a, c, d);
  }

  addBox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rotY = 0) {
    const hx = sx * 0.5;
    const hy = sy * 0.5;
    const hz = sz * 0.5;
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const xform = (lx: number, ly: number, lz: number): [number, number, number] => [
      cx + lx * c + lz * s,
      cy + ly,
      cz - lx * s + lz * c,
    ];
    const rNorm = (nx: number, ny: number, nz: number): [number, number, number] => [
      nx * c + nz * s,
      ny,
      -nx * s + nz * c,
    ];
    const faces: Array<{
      n: [number, number, number];
      v: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
    }> = [
      {
        n: [0, 1, 0],
        v: [
          [-hx, hy, -hz],
          [-hx, hy, hz],
          [hx, hy, hz],
          [hx, hy, -hz],
        ],
      },
      {
        n: [0, -1, 0],
        v: [
          [-hx, -hy, hz],
          [-hx, -hy, -hz],
          [hx, -hy, -hz],
          [hx, -hy, hz],
        ],
      },
      {
        n: [0, 0, 1],
        v: [
          [-hx, -hy, hz],
          [hx, -hy, hz],
          [hx, hy, hz],
          [-hx, hy, hz],
        ],
      },
      {
        n: [0, 0, -1],
        v: [
          [hx, -hy, -hz],
          [-hx, -hy, -hz],
          [-hx, hy, -hz],
          [hx, hy, -hz],
        ],
      },
      {
        n: [1, 0, 0],
        v: [
          [hx, -hy, hz],
          [hx, -hy, -hz],
          [hx, hy, -hz],
          [hx, hy, hz],
        ],
      },
      {
        n: [-1, 0, 0],
        v: [
          [-hx, -hy, -hz],
          [-hx, -hy, hz],
          [-hx, hy, hz],
          [-hx, hy, -hz],
        ],
      },
    ];
    for (const f of faces) {
      const [nx, ny, nz] = rNorm(f.n[0], f.n[1], f.n[2]);
      const p0 = xform(...f.v[0]);
      const p1 = xform(...f.v[1]);
      const p2 = xform(...f.v[2]);
      const p3 = xform(...f.v[3]);
      const i0 = this.addVertex(p0[0], p0[1], p0[2], nx, ny, nz, 0, 0);
      const i1 = this.addVertex(p1[0], p1[1], p1[2], nx, ny, nz, 1, 0);
      const i2 = this.addVertex(p2[0], p2[1], p2[2], nx, ny, nz, 1, 1);
      const i3 = this.addVertex(p3[0], p3[1], p3[2], nx, ny, nz, 0, 1);
      this.addQuad(i0, i1, i2, i3);
    }
  }

  /**
   * Adds a chamfered ring or toothed gear ring centered at (cx, cy, cz).
   */
  addChamferedRing(opts: {
    cx?: number;
    cy?: number;
    cz?: number;
    innerR: number;
    outerR: number;
    height: number;
    bevel?: number;
    segs?: number;
    teeth?: number;
    toothDepth?: number;
  }) {
    const cx = opts.cx ?? 0;
    const cy = opts.cy ?? 0;
    const cz = opts.cz ?? 0;
    const innerR = opts.innerR;
    const baseOuterR = opts.outerR;
    const h = opts.height * 0.5;
    const bev = Math.min(opts.bevel ?? opts.height * 0.16, h * 0.45, (baseOuterR - innerR) * 0.3);
    const teeth = opts.teeth ?? 0;
    const toothDepth = opts.toothDepth ?? 0;
    const segs = opts.segs ?? Math.max(96, teeth * 10);

    const outerRadiusAt = (theta: number) => {
      if (teeth <= 0 || toothDepth <= 0) return baseOuterR;
      // Smooth trapezoid profile (a tanh-shaped sine, not a true involute)
      const s = Math.sin(theta * teeth);
      const shaped = Math.tanh(s * 2.4) / Math.tanh(2.4);
      return baseOuterR + toothDepth * (shaped * 0.5 + 0.5);
    };

    const outerNormalAt = (theta: number): [number, number] => {
      const dTheta = 0.0015;
      const r0 = outerRadiusAt(theta - dTheta);
      const r1 = outerRadiusAt(theta + dTheta);
      const r = outerRadiusAt(theta);
      const dr = (r1 - r0) / (2 * dTheta);
      const tx = -Math.sin(theta) * r + Math.cos(theta) * dr;
      const tz = Math.cos(theta) * r + Math.sin(theta) * dr;
      const len = Math.hypot(tx, tz) || 1;
      return [tz / len, -tx / len];
    };

    // Top & Bottom flat annular faces
    for (const dir of [1, -1] as const) {
      const yFace = cy + dir * h;
      const baseIdx = this.positions.length / 3;
      for (let i = 0; i <= segs; i++) {
        const theta = (i / segs) * Math.PI * 2;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const rIn = innerR + bev;
        const rOut = outerRadiusAt(theta) - bev;
        const uIn = 0.5 + (c * rIn) / (2 * (baseOuterR + toothDepth));
        const vIn = 0.5 + (s * rIn) / (2 * (baseOuterR + toothDepth));
        const uOut = 0.5 + (c * rOut) / (2 * (baseOuterR + toothDepth));
        const vOut = 0.5 + (s * rOut) / (2 * (baseOuterR + toothDepth));
        this.addVertex(cx + c * rIn, yFace, cz + s * rIn, 0, dir, 0, uIn, vIn);
        this.addVertex(cx + c * rOut, yFace, cz + s * rOut, 0, dir, 0, uOut, vOut);
      }
      for (let i = 0; i < segs; i++) {
        const i0 = baseIdx + i * 2;
        const i1 = i0 + 1;
        const i2 = i0 + 3;
        const i3 = i0 + 2;
        if (dir === 1) this.addQuad(i0, i1, i2, i3);
        else this.addQuad(i0, i3, i2, i1);
      }
    }

    // Outer vertical wall + top/bottom 45-degree bevels
    const wallProfiles: Array<[number, number, number, number]> = [
      [h, -bev, 0.707, 0.707],
      [h - bev, 0, 1, 0],
      [h - bev, 0, 1, 0],
      [-h + bev, 0, 1, 0],
      [-h + bev, 0, 1, 0],
      [-h, -bev, 0.707, -0.707],
    ];
    for (let p = 0; p < wallProfiles.length; p += 2) {
      const [yA, drA, nrA, nyA] = wallProfiles[p];
      const [yB, drB, nrB, nyB] = wallProfiles[p + 1];
      const baseIdx = this.positions.length / 3;
      for (let i = 0; i <= segs; i++) {
        const theta = (i / segs) * Math.PI * 2;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const r = outerRadiusAt(theta);
        const [nx, nz] = outerNormalAt(theta);
        const u = (i / segs) * 8;
        this.addVertex(cx + c * (r + drA), cy + yA, cz + s * (r + drA), nx * nrA, nyA, nz * nrA, u, 0);
        this.addVertex(cx + c * (r + drB), cy + yB, cz + s * (r + drB), nx * nrB, nyB, nz * nrB, u, 1);
      }
      for (let i = 0; i < segs; i++) {
        const i0 = baseIdx + i * 2;
        this.addQuad(i0, i0 + 1, i0 + 3, i0 + 2);
      }
    }

    // Inner bore wall (if innerR > 0.001)
    if (innerR > 0.001) {
      const innerProfiles: Array<[number, number, number, number]> = [
        [h, bev, -0.707, 0.707],
        [h - bev, 0, -1, 0],
        [h - bev, 0, -1, 0],
        [-h + bev, 0, -1, 0],
        [-h + bev, 0, -1, 0],
        [-h, bev, -0.707, -0.707],
      ];
      for (let p = 0; p < innerProfiles.length; p += 2) {
        const [yA, drA, nrA, nyA] = innerProfiles[p];
        const [yB, drB, nrB, nyB] = innerProfiles[p + 1];
        const baseIdx = this.positions.length / 3;
        for (let i = 0; i <= segs; i++) {
          const theta = (i / segs) * Math.PI * 2;
          const c = Math.cos(theta);
          const s = Math.sin(theta);
          const u = (i / segs) * 4;
          this.addVertex(cx + c * (innerR + drA), cy + yA, cz + s * (innerR + drA), c * nrA, nyA, s * nrA, u, 0);
          this.addVertex(cx + c * (innerR + drB), cy + yB, cz + s * (innerR + drB), c * nrB, nyB, s * nrB, u, 1);
        }
        for (let i = 0; i < segs; i++) {
          const i0 = baseIdx + i * 2;
          this.addQuad(i0, i0 + 2, i0 + 3, i0 + 1);
        }
      }
    }
  }

  /**
   * Builds a complete skeletonized CNC gear wheel with chamfered teeth, spokes, central boss, and jewel bore.
   */
  addSkeletonGear(opts: { pitchR: number; teeth: number; thickness: number; spokes: number; boreR?: number }) {
    const moduleSize = (opts.pitchR * 2) / opts.teeth;
    const toothDepth = moduleSize * 1.95;
    const rootR = opts.pitchR - toothDepth * 0.52;
    const rimInnerR = rootR * 0.78;
    const hubOuterR = Math.max((opts.boreR ?? 0.03) * 2.2, rootR * 0.28);
    const boreR = opts.boreR ?? 0.025;

    // 1. Toothed Outer Rim
    this.addChamferedRing({
      innerR: rimInnerR,
      outerR: rootR,
      height: opts.thickness,
      bevel: opts.thickness * 0.16,
      teeth: opts.teeth,
      toothDepth,
      segs: opts.teeth * 12,
    });

    // 2. Central Hub Boss (slightly thicker than spokes)
    this.addChamferedRing({
      innerR: boreR,
      outerR: hubOuterR,
      height: opts.thickness * 1.25,
      bevel: opts.thickness * 0.15,
      segs: 64,
    });

    // 3. Radial Openwork Spokes
    const spokeLen = rimInnerR - hubOuterR + 0.02;
    const spokeMidR = (rimInnerR + hubOuterR) * 0.5;
    const spokeW = Math.max(0.022, opts.pitchR * 0.085);
    for (let s = 0; s < opts.spokes; s++) {
      const a = (s / opts.spokes) * Math.PI * 2;
      this.addBox(Math.cos(a) * spokeMidR, 0, -Math.sin(a) * spokeMidR, spokeLen, opts.thickness * 0.72, spokeW, a);
    }
  }

  toMeshGeometry(): MeshGeometry {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
    };
  }
}

// ============================================================================
// 3. BUILD THE 6 PROCEDURAL SUB-ASSEMBLIES OF CALIBRE M900
// ============================================================================

interface SubAssemblySpec {
  key: string;
  label: string;
  shortPin: string;
  category: string;
  description: string;
  basePos: [number, number, number];
  explodeVec: [number, number, number];
  calloutElbow: [number, number];
  cameraFocusDir: [number, number, number];
  gearRatio?: number;
  phaseOffset?: number;
  isBalance?: boolean;
}

const SUB_ASSEMBLIES: SubAssemblySpec[] = [
  {
    key: 'sapphire_bezel',
    label: 'Fluted Titanium Bezel & Sapphire Ring',
    shortPin: '01 · Sapphire & Bezel',
    category: 'CRYSTAL · IOR 1.77 + CLEARCOAT',
    description:
      'CNC-fluted titanium outer case ring with 60 applied titanium indices and a flat sapphire chapter ring rendered with physical transmission and specular clearcoat.',
    basePos: [0, 0.22, 0],
    explodeVec: [0, 0.68, 0],
    calloutElbow: [145, -52],
    cameraFocusDir: [0.55, 0.65, 1.15],
  },
  {
    key: 'geneva_bridge',
    label: 'Côtes de Genève Upper Chronograph Bridge',
    shortPin: '02 · Geneva Bridge',
    category: 'BRIDGE · 512 PX STRIPES NORMAL MAP',
    description:
      'Rhodium bridge spanning above the gear train on two outer pillars, with a procedural Côtes de Genève normal map and a ruby jewel cap.',
    basePos: [0, 0.16, 0],
    explodeVec: [0, 0.38, 0],
    calloutElbow: [-145, -42],
    cameraFocusDir: [-0.62, 0.55, 1.05],
  },
  {
    key: 'balance_escapement',
    label: '4 Hz Balance Wheel & Concentric Hairspring',
    shortPin: '03 · 4 Hz Balance Wheel',
    category: 'ESCAPEMENT · 28,800 VPH OSCILLATOR',
    description:
      'Rose-gold balance wheel with 16 timing weights and four concentric hairspring rings, oscillating in its horizontal plane at 4.0 Hz.',
    basePos: [-0.36, 0.04, 0.34],
    explodeVec: [-0.28, 0.18, 0.28],
    calloutElbow: [-140, 22],
    cameraFocusDir: [-0.68, 0.42, 0.85],
    isBalance: true,
  },
  {
    key: 'center_chrono_wheel',
    label: '18K Rose-Gold Great Wheel & Sweeping Hands',
    shortPin: '04 · Center Great Wheel',
    category: 'GEAR TRAIN · 48 TEETH',
    description:
      'Skeletonized 48-tooth center wheel with 6 chamfered spokes, circular satin normal map, and coaxial chronograph hands locked mathematically to the drive train.',
    basePos: [0, -0.01, 0],
    explodeVec: [0, 0.02, 0],
    calloutElbow: [145, -8],
    cameraFocusDir: [0.48, 0.45, 0.88],
    gearRatio: 1.0,
    phaseOffset: 0,
  },
  {
    key: 'transmission_train',
    label: 'Meshing Pinion & Mainspring Barrel Wheel',
    shortPin: '05 · Mainspring Barrel',
    category: 'TRANSMISSION · EXACT MESH RATIO',
    description:
      '32-tooth skeletonized intermediate transmission wheel meshing tangentially with the 48-tooth center wheel at exact pitch radius sum (R1 + R2 = 0.65) so teeth interlock without clipping.',
    basePos: [0.4596, -0.01, -0.4596],
    explodeVec: [0.28, -0.18, -0.28],
    calloutElbow: [145, 38],
    cameraFocusDir: [0.75, 0.42, 0.82],
    gearRatio: -48 / 32,
    phaseOffset: 0.098,
  },
  {
    key: 'sculpted_mainplate',
    label: 'Mainplate & Case Lugs',
    shortPin: '06 · Sculpted Mainplate',
    category: 'CHASSIS · ANISOTROPIC TITANIUM',
    description:
      'Two-tier titanium baseplate with a nested counter-wheel and 4 case lugs, grounded by separable-Gaussian ContactShadows.',
    basePos: [0, -0.14, 0],
    explodeVec: [0, -0.44, 0],
    calloutElbow: [-140, 56],
    cameraFocusDir: [-0.58, 0.35, 1.18],
  },
];

interface ChapterConfig {
  kicker: string;
  headlineHtml: string;
  lead: string;
  camPos: [number, number, number];
  camTarget: [number, number, number];
  explode: number;
  highlightKey: string | null;
}

const CHAPTERS: ChapterConfig[] = [
  {
    kicker: 'CHAPTER 01 · CALIBRE M900',
    headlineHtml: 'Mathematical Horology.<br /><strong>Built From Pure Code.</strong>',
    lead: 'Every chamfered gear tooth, skeletonized spoke, Côtes de Genève bridge, hairspring, and sapphire ring is synthesized procedurally in TypeScript with 512 px normal maps and HDR studio IBL.',
    camPos: [1.32, 1.52, 2.35],
    camTarget: [-0.05, 0.0, 0.0],
    explode: 0,
    highlightKey: null,
  },
  {
    kicker: 'CHAPTER 02 · GEAR TRAIN',
    headlineHtml: 'Exact Pitch Tangency.<br /><strong>Zero Tooth Clipping.</strong>',
    lead: 'The 48-tooth rose-gold center wheel and 32-tooth rhodium barrel wheel sit at exact pitch-circle tangency (R1 + R2 = 0.65) with locked angular velocity ω₂ = -(48/32)ω₁.',
    camPos: [0.68, 0.82, 1.05],
    camTarget: [0.16, 0.02, -0.16],
    explode: 0.14,
    highlightKey: 'center_chrono_wheel',
  },
  {
    kicker: 'CHAPTER 03 · 4 HZ BALANCE & RUBY',
    headlineHtml: '28,800 Beats Per Hour.<br /><strong>In-Plane Coaxial Clearance.</strong>',
    lead: 'Inspect the oscillating balance wheel and its concentric hairspring rings, rotating in their horizontal deck beneath the Geneva bridge and its ruby jewel cap.',
    camPos: [-0.75, 0.72, 0.98],
    camTarget: [-0.28, 0.05, 0.26],
    explode: 0.08,
    highlightKey: 'balance_escapement',
  },
  {
    kicker: 'CHAPTER 04 · EXPLODED CAD STACK',
    headlineHtml: 'Six Decks.<br /><strong>Full Disassembly.</strong>',
    lead: 'Slide the disassembly control or click any floating 3D engineering callout to separate all six horological decks along their explode paths, with live GPU Jump-Flood outlines.',
    camPos: [1.68, 1.24, 2.78],
    camTarget: [-0.06, 0.1, 0.0],
    explode: 1.0,
    highlightKey: null,
  },
];

function projectToScreen(
  worldPos: [number, number, number],
  vp: Float32Array,
  width: number,
  height: number,
): { x: number; y: number; visible: boolean } {
  const [wx, wy, wz] = worldPos;
  const cx = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12];
  const cy = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13];
  const cz = vp[2] * wx + vp[6] * wy + vp[10] * wz + vp[14];
  const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
  if (cw <= 0.05) return { x: -9999, y: -9999, visible: false };
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  const ndcZ = cz / cw;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1.0 - (ndcY * 0.5 + 0.5)) * height,
    visible: ndcZ >= -1 && ndcZ <= 1,
  };
}

// Custom WGSL Studio Telemetry Ring & Atmospheric Gold Dust
const pedestalShader = /* wgsl */ `
struct Out { @builtin(position) clip:vec4f, @location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) v:u32)->Out {
  let corner = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  )[v];
  let r = 1.65;
  let worldPos = vec3f(corner.x * r, uniforms.floorY, corner.y * r);
  return Out(camera.viewProjection * vec4f(worldPos, 1.0), corner);
}

@fragment fn fragment(i:Out)->@location(0) vec4f {
  let r = length(i.uv);
  if (r > 1.0) { discard; }
  let angle = atan2(i.uv.y, i.uv.x);
  let ring1 = smoothstep(0.006, 0.0, abs(r - 0.56));
  let ring2 = smoothstep(0.004, 0.0, abs(r - 0.76));
  let ring3 = smoothstep(0.006, 0.0, abs(r - 0.94));
  let ticks = step(0.90, cos(angle * 60.0 - camera.time * 0.4)) * smoothstep(0.025, 0.0, abs(r - 0.85));
  let pulse = smoothstep(0.025, 0.0, abs(fract(r * 2.5 - camera.time * 0.2) - 0.5)) * uniforms.explode * 0.55;

  let gold = vec3f(0.92, 0.68, 0.34);
  let cyan = vec3f(0.36, 0.88, 0.92);
  let base = vec3f(0.02, 0.03, 0.05);
  let mask = clamp(ring1 * 0.5 + ring2 * 0.35 + ring3 * 0.7 + ticks * 0.5 + pulse, 0.0, 1.0);
  let col = mix(base, mix(gold, cyan, pulse + ring2 * 0.35), mask);
  let alpha = (0.30 * (1.0 - r * 0.5) + mask * 0.65) * smoothstep(1.0, 0.76, r);
  return margoDisplay(vec4f(col * alpha, alpha));
}
`;

async function main() {
  const loaderOverlay = document.getElementById('loader-overlay') as HTMLDivElement;
  const backendBadge = document.getElementById('backend-badge') as HTMLSpanElement;

  const stage = await createStage('#viewport', {
    backend: 'webgpu',
    autoStart: false,
    controls: false,
    capacity: 2048,
    label: 'Chrono-IX Calibre M900 100% Procedural CNC Horology Showcase',
    camera: {
      fov: 35,
      near: 0.04,
      far: 40,
      position: CHAPTERS[0].camPos,
      target: CHAPTERS[0].camTarget,
    },
  });

  paceEngine(stage.engine);
  backendBadge.textContent = 'WebGPU Native';

  const controls = OrbitControls.attach(stage.engine);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 0.75;
  controls.maxDistance = 4.2;
  controls.maxPolarAngle = Math.PI * 0.52;

  // 1. Procedural HDR Studio Softbox IBL + Core Key Light
  const environment = await Environment.attach(stage.engine, createProceduralStudioHDR(), {
    intensity: 1.4,
    rotation: 0.35,
  });
  const envLighting = EnvironmentLighting.attach(stage.engine, environment);

  stage.engine.lighting.direction.set([-2.4, 5.2, 3.0, 2.8]);
  stage.engine.lighting.radiance.set([1.0, 0.95, 0.88, 0.22]);

  // 2. PostStack: 32-Tap SSAO + Bloom + Khronos PBR Neutral Tonemap
  const ssao = new SSAO({ radius: 0.22, bias: 0.008, samples: 32 });
  const bloom = new Bloom({ strength: 0.16, threshold: 1.1, exposure: 0 });
  const tonemap = new Tonemap({
    curve: 'neutral',
    exposure: 0.16,
    contrast: 1.06,
    vignette: 0.22,
  });
  PostStack.attach(stage.engine, [ssao, bloom, tonemap]);

  // 3. Procedural 512 px Normal Maps & Luxury Horological PBR Materials
  const genevaNormal = createGenevaStripesNormalMap(512);
  const radialNormal = createRadialBrushedNormalMap(512);

  const roseGoldMat = new PbrMaterial({
    color: '#f2b880',
    metalness: 1.0,
    roughness: 0.16,
    normalMap: radialNormal,
    normalScale: 0.45,
    anisotropy: 0.75,
    clearcoat: 0.35,
    clearcoatRoughness: 0.1,
  });

  const rhodiumBridgeMat = new PbrMaterial({
    color: '#d8dee9',
    metalness: 0.98,
    roughness: 0.2,
    normalMap: genevaNormal,
    normalScale: 0.55,
    anisotropy: 0.65,
    clearcoat: 0.4,
    clearcoatRoughness: 0.12,
  });

  const titaniumChassisMat = new PbrMaterial({
    color: '#6e7889',
    metalness: 0.94,
    roughness: 0.26,
    normalMap: radialNormal,
    normalScale: 0.38,
    anisotropy: 0.5,
  });

  const bluedSteelMat = new PbrMaterial({
    color: '#2864c8',
    metalness: 0.96,
    roughness: 0.12,
    iridescence: 0.45,
    clearcoat: 0.6,
  });

  const rubyJewelMat = new PbrMaterial({
    color: '#ff1e56',
    metalness: 0.08,
    roughness: 0.05,
    transmission: 0.82,
    ior: 1.77,
    clearcoat: 1.0,
  });

  const sapphireGlassMat = new PbrMaterial({
    color: '#e6f4ff',
    metalness: 0.0,
    roughness: 0.04,
    transmission: 0.88,
    ior: 1.77,
    clearcoat: 1.0,
    transparent: true,
    opacity: 0.32,
  });

  // 4. Synthesize the 6 High-Polygon Sub-Assembly Meshes
  // --- Assembly 1: Fluted Titanium Bezel, 60 Applied Indices & Sapphire Crystal Ring ---
  const b1 = new GeometryBuilder();
  b1.addChamferedRing({
    innerR: 0.94,
    outerR: 1.12,
    height: 0.1,
    bevel: 0.022,
    teeth: 72,
    toothDepth: 0.018,
    segs: 288,
  });
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const isHour = i % 5 === 0;
    const rMid = isHour ? 0.88 : 0.9;
    const len = isHour ? 0.09 : 0.045;
    const w = isHour ? 0.022 : 0.01;
    b1.addBox(Math.cos(a) * rMid, 0.045, -Math.sin(a) * rMid, len, 0.018, w, a);
  }
  const meshBezel = createMesh(stage.engine, b1.toMeshGeometry(), titaniumChassisMat);

  // Thin anti-reflective sapphire chapter ring nested inside bezel (open-heart skeleton center)
  const bCrystal = new GeometryBuilder();
  bCrystal.addChamferedRing({
    innerR: 0.78,
    outerR: 0.935,
    height: 0.018,
    bevel: 0.004,
    segs: 128,
  });
  const meshCrystal = createMesh(stage.engine, bCrystal.toMeshGeometry(), sapphireGlassMat);
  meshCrystal.root.setParent(meshBezel.root);
  meshCrystal.root.setPosition([0, 0.04, 0]);

  // --- Assembly 2: Côtes de Genève Upper Chronograph Bridge (with outer perimeter pillars) ---
  const b2 = new GeometryBuilder();
  b2.addChamferedRing({ innerR: 0.045, outerR: 0.16, height: 0.055, bevel: 0.012, segs: 64 });
  b2.addBox(-0.42, 0, 0, 0.68, 0.045, 0.14, 0);
  b2.addBox(0.42, 0, 0, 0.68, 0.045, 0.14, 0);
  // Outer vertical stanchion pillars at x = ±0.78 (completely outside all rotating gears!)
  b2.addChamferedRing({
    cx: -0.76,
    cy: -0.14,
    cz: 0,
    innerR: 0.02,
    outerR: 0.075,
    height: 0.28,
    bevel: 0.012,
    segs: 48,
  });
  b2.addChamferedRing({
    cx: 0.76,
    cy: -0.14,
    cz: 0,
    innerR: 0.02,
    outerR: 0.075,
    height: 0.28,
    bevel: 0.012,
    segs: 48,
  });
  const meshBridge = createMesh(stage.engine, b2.toMeshGeometry(), rhodiumBridgeMat);

  // Synthetic Ruby Jewel Cap in the center of the Geneva Bridge
  const bRuby = new GeometryBuilder();
  bRuby.addChamferedRing({ innerR: 0.01, outerR: 0.055, height: 0.07, bevel: 0.012, segs: 48 });
  const meshBridgeRuby = createMesh(stage.engine, bRuby.toMeshGeometry(), rubyJewelMat);
  meshBridgeRuby.root.setParent(meshBridge.root);

  // --- Assembly 3: 4 Hz Balance Wheel, Timing Weights & Concentric Hairspring ---
  const b3 = new GeometryBuilder();
  b3.addChamferedRing({ innerR: 0.24, outerR: 0.29, height: 0.042, bevel: 0.009, segs: 120 });
  b3.addChamferedRing({ innerR: 0.018, outerR: 0.065, height: 0.06, bevel: 0.01, segs: 48 });
  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * Math.PI * 2;
    b3.addBox(Math.cos(a) * 0.15, 0, -Math.sin(a) * 0.15, 0.19, 0.028, 0.024, a);
  }
  // 16 peripheral micro-timing Poise screws around the balance rim
  for (let w = 0; w < 16; w++) {
    const a = (w / 16) * Math.PI * 2;
    b3.addBox(Math.cos(a) * 0.305, 0, -Math.sin(a) * 0.305, 0.028, 0.024, 0.022, a);
  }
  // Concentric hairspring rings
  for (let c = 1; c <= 4; c++) {
    const r = 0.075 + c * 0.032;
    b3.addChamferedRing({
      cy: 0.028,
      innerR: r,
      outerR: r + 0.008,
      height: 0.016,
      bevel: 0.002,
      segs: 96,
    });
  }
  const meshBalance = createMesh(stage.engine, b3.toMeshGeometry(), roseGoldMat);

  // --- Assembly 4: 48-Tooth 18K Rose-Gold Center Great Wheel & Coaxial Chrono Hands ---
  // Pitch radius R1 = 0.39, teeth = 48 (module = 0.01625)
  const b4 = new GeometryBuilder();
  b4.addSkeletonGear({
    pitchR: 0.39,
    teeth: 48,
    thickness: 0.052,
    spokes: 6,
    boreR: 0.03,
  });
  const meshCenterGear = createMesh(stage.engine, b4.toMeshGeometry(), roseGoldMat);

  // Blued-steel skeletonized Chronograph Hands mounted on the Center Wheel arbor
  const bHands = new GeometryBuilder();
  bHands.addChamferedRing({
    cy: 0.09,
    innerR: 0.015,
    outerR: 0.055,
    height: 0.14,
    bevel: 0.008,
    segs: 48,
  });
  bHands.addBox(0.32, 0.14, 0, 0.62, 0.014, 0.022, 0);
  bHands.addBox(-0.12, 0.14, 0, 0.2, 0.014, 0.032, 0);
  const meshHands = createMesh(stage.engine, bHands.toMeshGeometry(), bluedSteelMat);
  meshHands.root.setParent(meshCenterGear.root);

  // --- Assembly 5: 32-Tooth Meshing Transmission & Mainspring Barrel Wheel ---
  // Pitch radius R2 = 0.26, teeth = 32 (same module = 0.01625! Distance R1 + R2 = 0.65!)
  const b5 = new GeometryBuilder();
  b5.addSkeletonGear({
    pitchR: 0.26,
    teeth: 32,
    thickness: 0.052,
    spokes: 5,
    boreR: 0.025,
  });
  // Coaxial upper ratchet wheel on same barrel arbor
  b5.addChamferedRing({
    cy: 0.048,
    innerR: 0.03,
    outerR: 0.16,
    height: 0.032,
    bevel: 0.006,
    teeth: 24,
    toothDepth: 0.018,
    segs: 192,
  });
  const meshBarrelGear = createMesh(stage.engine, b5.toMeshGeometry(), rhodiumBridgeMat);

  // --- Assembly 6: Engine-Turned Sculpted Mainplate & Perimeter Lugs ---
  const b6 = new GeometryBuilder();
  b6.addChamferedRing({ innerR: 0.08, outerR: 1.08, height: 0.08, bevel: 0.018, segs: 160 });
  b6.addChamferedRing({
    cy: 0.045,
    innerR: 0.84,
    outerR: 1.06,
    height: 0.05,
    bevel: 0.012,
    segs: 140,
  });
  // Secondary lower counter-gear nested on the mainplate at (-0.38, 0.06, -0.34)
  b6.addChamferedRing({
    cx: -0.38,
    cy: 0.055,
    cz: -0.34,
    innerR: 0.04,
    outerR: 0.22,
    height: 0.036,
    bevel: 0.008,
    teeth: 28,
    toothDepth: 0.02,
    segs: 224,
  });
  // 4 sculpted watch case lugs at the corners
  for (const lugAngle of [0.42, Math.PI - 0.42, Math.PI + 0.42, -0.42]) {
    b6.addBox(Math.cos(lugAngle) * 1.18, 0.02, -Math.sin(lugAngle) * 1.18, 0.26, 0.09, 0.14, lugAngle);
  }
  const meshMainplate = createMesh(stage.engine, b6.toMeshGeometry(), titaniumChassisMat);

  const allModels: MaterialMesh[] = [
    meshBezel,
    meshCrystal,
    meshBridge,
    meshBridgeRuby,
    meshBalance,
    meshCenterGear,
    meshHands,
    meshBarrelGear,
    meshMainplate,
  ];

  const primaryMeshes: MaterialMesh[] = [
    meshBezel,
    meshBridge,
    meshBalance,
    meshCenterGear,
    meshBarrelGear,
    meshMainplate,
  ];

  // Register every procedural PBR mesh with IBL, SSAO, ContactShadows, Picking, Selection
  const floorY = -0.32;
  const contactShadows = ContactShadows.attach(stage.engine, {
    position: [0, floorY, 0],
    size: 3.2,
    height: 1.6,
    blur: 0.08,
    opacity: 0.82,
    resolution: 512,
  });
  const picking = Picking.attach(stage.engine);
  const selection = Selection.attach(stage.engine, {
    width: 3,
    color: [0.95, 0.72, 0.32],
    xray: { dash: 4, opacity: 0.65 },
  });

  for (const m of allModels) {
    envLighting.add(m);
    ssao.add(m);
    contactShadows.add(m);
    picking.add(m);
    selection.add(m);
  }

  // Custom WGSL Floor Calibration Ring
  const rawShaders = RawShaders.attach(stage.engine);
  const pedestalMat = new RawShaderMaterial({
    vertexShader: pedestalShader,
    uniforms: {
      floorY: { value: floorY - 0.002 },
      explode: { value: 0 },
    },
    transparent: true,
    blending: 'normal',
    depthWrite: false,
    cull: 'none',
    name: 'calibre-pedestal-ring',
  });
  rawShaders.add(new RawMesh({ material: pedestalMat, vertexCount: 6 }));

  // 5. Build Inspector List & Floating 3D Callout Pins
  const pinsContainer = document.getElementById('pins-container') as HTMLDivElement;
  const calloutSvg = document.getElementById('callout-layer') as unknown as SVGSVGElement;
  const partListEl = document.getElementById('part-list') as HTMLDivElement;
  const partTitleEl = document.getElementById('part-title') as HTMLDivElement;
  const partDescEl = document.getElementById('part-desc') as HTMLDivElement;
  const specGeoEl = document.getElementById('spec-geo') as HTMLDivElement;
  const specTexEl = document.getElementById('spec-tex') as HTMLDivElement;

  interface TrackedAssembly {
    spec: SubAssemblySpec;
    model: MaterialMesh;
    vertexCount: number;
    triangleCount: number;
    pinEl: HTMLButtonElement;
    listEl: HTMLDivElement;
  }

  const tracked: TrackedAssembly[] = [];
  let totalVertices = 0;
  let totalTriangles = 0;

  for (let i = 0; i < SUB_ASSEMBLIES.length; i++) {
    const spec = SUB_ASSEMBLIES[i];
    const model = primaryMeshes[i];
    const prim = model.primitives[0];
    const vertexCount = Math.floor(prim.vertices.length / 20);
    const triangleCount = Math.floor(prim.indices.length / 3);
    totalVertices += vertexCount;
    totalTriangles += triangleCount;

    const pinEl = document.createElement('button');
    pinEl.className = 'callout-pin';
    pinEl.innerHTML = `<span class="callout-dot"></span><span>${spec.shortPin}</span>`;
    pinEl.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSubAssembly(spec.key, true);
    });
    pinsContainer.appendChild(pinEl);

    const listEl = document.createElement('div');
    listEl.className = 'part-item';
    listEl.innerHTML = `
      <span>${spec.shortPin}</span>
      <span class="part-meta">${triangleCount.toLocaleString()} tris</span>
    `;
    listEl.addEventListener('click', () => {
      selectSubAssembly(spec.key, true);
    });
    partListEl.appendChild(listEl);

    tracked.push({
      spec,
      model,
      vertexCount,
      triangleCount,
      pinEl,
      listEl,
    });
  }

  specGeoEl.textContent = `${totalVertices.toLocaleString()} / ${totalTriangles.toLocaleString()}`;

  // 6. Interactive State & Camera Choreography
  let targetExplode = 0.0;
  let currentExplode = 0.0;
  let turntableEnabled = true;
  let calloutsEnabled = true;
  let turntableAngle = 0.0;
  let selectedKey: string | null = null;
  let activeChapterIndex = 0;

  let camFlightActive = false;
  const desiredCamPos: [number, number, number] = [...CHAPTERS[0].camPos];
  const desiredCamTarget: [number, number, number] = [...CHAPTERS[0].camTarget];

  const explodeSlider = document.getElementById('explode-slider') as HTMLInputElement;
  const explodePct = document.getElementById('explode-pct') as HTMLSpanElement;
  const btnExplode = document.getElementById('btn-explode') as HTMLButtonElement;

  function syncExplodeUI(val: number) {
    const pct = Math.round(val * 100);
    explodeSlider.value = String(pct);
    explodePct.textContent = `${pct}%`;
    btnExplode.textContent = val > 0.5 ? 'Reassemble Calibre' : 'Explode Calibre Stack';
  }

  function selectSubAssembly(key: string | null, flyToPart = false) {
    selectedKey = key;
    const selectedModels: MaterialMesh[] = [];

    for (const item of tracked) {
      const isMatch = item.spec.key === key;
      item.pinEl.classList.toggle('active', isMatch);
      item.listEl.classList.toggle('active', isMatch);
      if (isMatch) {
        selectedModels.push(item.model);
        partTitleEl.textContent = item.spec.label;
        partDescEl.textContent = item.spec.description;
        specGeoEl.textContent = `${item.vertexCount.toLocaleString()} / ${item.triangleCount.toLocaleString()}`;
        specTexEl.textContent = item.spec.category;

        if (flyToPart) {
          const c = Math.cos(turntableAngle);
          const s = Math.sin(turntableAngle);
          const lx = item.spec.basePos[0] + item.spec.explodeVec[0] * targetExplode;
          const ly = item.spec.basePos[1] + item.spec.explodeVec[1] * targetExplode;
          const lz = item.spec.basePos[2] + item.spec.explodeVec[2] * targetExplode;
          const wx = lx * c + lz * s;
          const wz = -lx * s + lz * c;

          desiredCamTarget[0] = wx;
          desiredCamTarget[1] = ly;
          desiredCamTarget[2] = wz;

          desiredCamPos[0] = wx + item.spec.cameraFocusDir[0];
          desiredCamPos[1] = ly + item.spec.cameraFocusDir[1];
          desiredCamPos[2] = wz + item.spec.cameraFocusDir[2];
          camFlightActive = true;
        }
      }
    }

    selection.set(selectedModels);

    if (!key) {
      partTitleEl.textContent = 'Calibre M900 Complete Movement';
      partDescEl.textContent =
        'Click any gear wheel, bridge, balance assembly, or sapphire bezel on the 3D movement to isolate its GPU Jump-Flood outline and inspect its procedural geometry.';
      specGeoEl.textContent = `${totalVertices.toLocaleString()} / ${totalTriangles.toLocaleString()}`;
      specTexEl.textContent = '512 px Geneva + Satin';
    }
  }

  function activateChapter(index: number) {
    activeChapterIndex = (index + CHAPTERS.length) % CHAPTERS.length;
    const ch = CHAPTERS[activeChapterIndex];

    document.querySelectorAll<HTMLButtonElement>('.chapter-btn').forEach((btn, idx) => {
      btn.classList.toggle('active', idx === activeChapterIndex);
    });

    (document.getElementById('chapter-kicker') as HTMLSpanElement).textContent = ch.kicker;
    (document.getElementById('chapter-headline') as HTMLHeadingElement).innerHTML = ch.headlineHtml;
    (document.getElementById('chapter-lead') as HTMLParagraphElement).textContent = ch.lead;

    targetExplode = ch.explode;
    syncExplodeUI(targetExplode);

    desiredCamPos[0] = ch.camPos[0];
    desiredCamPos[1] = ch.camPos[1];
    desiredCamPos[2] = ch.camPos[2];
    desiredCamTarget[0] = ch.camTarget[0];
    desiredCamTarget[1] = ch.camTarget[1];
    desiredCamTarget[2] = ch.camTarget[2];
    camFlightActive = true;

    selectSubAssembly(ch.highlightKey, false);
  }

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

  // GPU Picking Click Handler
  let downPos = { x: 0, y: 0 };
  stage.canvas.addEventListener('pointerdown', (e) => {
    downPos = { x: e.clientX, y: e.clientY };
  });
  stage.canvas.addEventListener('pointerup', async (e) => {
    const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    if (dist > 5) return;
    const rect = stage.canvas.getBoundingClientRect();
    const hit = await picking.pick(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      const found = tracked.find((t) => t.model === hit.model || t.model.root === (hit.mesh as unknown as Mesh));
      if (found) {
        selectSubAssembly(found.spec.key, true);
        return;
      }
    }
    selectSubAssembly(null, false);
  });

  // UI Controls
  document.querySelectorAll<HTMLButtonElement>('.chapter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activateChapter(Number(btn.dataset.chapter ?? '0'));
    });
  });

  explodeSlider.addEventListener('input', () => {
    targetExplode = Number(explodeSlider.value) / 100;
    syncExplodeUI(targetExplode);
  });

  btnExplode.addEventListener('click', () => {
    activateChapter(targetExplode > 0.5 ? 0 : 3);
  });

  document.getElementById('btn-next-chapter')?.addEventListener('click', () => {
    activateChapter(activeChapterIndex + 1);
  });

  const btnCallouts = document.getElementById('btn-callouts') as HTMLButtonElement;
  btnCallouts.addEventListener('click', () => {
    calloutsEnabled = !calloutsEnabled;
    btnCallouts.classList.toggle('active', calloutsEnabled);
    pinsContainer.style.display = calloutsEnabled ? 'block' : 'none';
    calloutSvg.style.display = calloutsEnabled ? 'block' : 'none';
  });

  const btnTurntable = document.getElementById('btn-turntable') as HTMLButtonElement;
  btnTurntable.addEventListener('click', () => {
    turntableEnabled = !turntableEnabled;
    btnTurntable.classList.toggle('active', turntableEnabled);
    btnTurntable.textContent = turntableEnabled ? 'Turntable: ON' : 'Turntable: OFF';
  });

  document.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.env;
      if (mode === 'atelier') {
        environment.intensity = 1.4;
        environment.rotation = 0.35;
        tonemap.options.exposure = 0.16;
        tonemap.options.temperature = 6500;
      } else if (mode === 'rose') {
        environment.intensity = 1.28;
        environment.rotation = 1.5;
        tonemap.options.exposure = 0.22;
        tonemap.options.temperature = 7900;
      } else if (mode === 'cryo') {
        environment.intensity = 1.25;
        environment.rotation = -1.1;
        tonemap.options.exposure = 0.18;
        tonemap.options.temperature = 5100;
      }
    });
  });

  const specFpsEl = document.getElementById('spec-fps') as HTMLDivElement;
  let smoothedFps = 60;
  let elapsed = 0;

  stage.use({
    name: 'calibre-m900-loop',
    setup() {},
    onPreUpdate(dt) {
      const clampedDt = Math.min(dt, 0.1);
      elapsed += clampedDt;

      if (dt > 0.0001) {
        smoothedFps = smoothedFps * 0.92 + (1 / dt) * 0.08;
        specFpsEl.textContent = `${Math.min(120, smoothedFps).toFixed(1)} FPS`;
      }

      currentExplode += (targetExplode - currentExplode) * Math.min(1, clampedDt * 7.5);
      pedestalMat.uniforms.explode.value = currentExplode;

      if (turntableEnabled) {
        turntableAngle += clampedDt * 0.22;
      }

      const cam = stage.engine.camera;
      if (camFlightActive) {
        const k = Math.min(1, clampedDt * 5.5);
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
        if (err < 0.004) camFlightActive = false;
      }

      controls.update(clampedDt);

      // Update each of the 6 horological sub-assemblies with exact meshing gear kinematics + turntable rotation
      const c = Math.cos(turntableAngle);
      const s = Math.sin(turntableAngle);
      const baseGearOmega = elapsed * 0.48;

      const width = window.innerWidth;
      const height = window.innerHeight;
      const vp = cam.matrix;
      let svgLinesHtml = '';

      for (const item of tracked) {
        const { basePos, explodeVec, gearRatio, phaseOffset, isBalance } = item.spec;
        const lx = basePos[0] + explodeVec[0] * currentExplode;
        const ly = basePos[1] + explodeVec[1] * currentExplode;
        const lz = basePos[2] + explodeVec[2] * currentExplode;

        const wx = lx * c + lz * s;
        const wz = -lx * s + lz * c;

        let localSpin = 0;
        if (isBalance) {
          // 4.0 Hz (28,800 vph) harmonic balance wheel oscillation in-plane
          localSpin = Math.sin(elapsed * Math.PI * 8.0) * 1.35;
        } else if (gearRatio !== undefined) {
          localSpin = baseGearOmega * gearRatio + (phaseOffset ?? 0);
        }

        item.model.root.setPosition([wx, ly, wz]);
        item.model.root.setRotation([0, turntableAngle + localSpin, 0]);

        if (calloutsEnabled) {
          const anchorScreen = projectToScreen([wx, ly, wz], vp, width, height);
          const showPin =
            anchorScreen.visible &&
            (currentExplode > 0.1 || selectedKey === item.spec.key) &&
            anchorScreen.x > 340 &&
            anchorScreen.x < width - 300 &&
            anchorScreen.y > 90 &&
            anchorScreen.y < height - 90;

          if (showPin) {
            const rawPinX = anchorScreen.x + item.spec.calloutElbow[0];
            const rawPinY = anchorScreen.y + item.spec.calloutElbow[1];
            const pinX = Math.max(485, Math.min(width - 435, rawPinX));
            const pinY = Math.max(105, Math.min(height - 95, rawPinY));

            item.pinEl.style.opacity = '1';
            item.pinEl.style.pointerEvents = 'auto';
            item.pinEl.style.left = `${pinX}px`;
            item.pinEl.style.top = `${pinY}px`;

            const isSelected = selectedKey === item.spec.key;
            const stroke = isSelected ? 'rgba(92, 225, 230, 0.9)' : 'rgba(235, 174, 88, 0.6)';
            const midX = anchorScreen.x + (pinX - anchorScreen.x) * 0.45;
            const midY = pinY;

            svgLinesHtml += `
              <polyline
                points="${anchorScreen.x.toFixed(1)},${anchorScreen.y.toFixed(1)} ${midX.toFixed(1)},${midY.toFixed(1)} ${pinX.toFixed(1)},${pinY.toFixed(1)}"
                fill="none"
                stroke="${stroke}"
                stroke-width="${isSelected ? '1.8' : '1.2'}"
                stroke-dasharray="${isSelected ? 'none' : '3 3'}"
              />
              <circle
                cx="${anchorScreen.x.toFixed(1)}"
                cy="${anchorScreen.y.toFixed(1)}"
                r="3.2"
                fill="${stroke}"
              />
            `;
          } else {
            item.pinEl.style.opacity = '0';
            item.pinEl.style.pointerEvents = 'none';
          }
        }
      }

      if (calloutsEnabled) {
        calloutSvg.innerHTML = svgLinesHtml;
      }
    },
    dispose: () => controls.dispose(),
  });

  stage.engine.render();
  stage.engine.start();
  loaderOverlay.classList.add('hidden');

  window.addEventListener('pagehide', () => stage.dispose(), { once: true });
}

ready(
  main().catch((err) => {
    console.error(err);
  }),
);
