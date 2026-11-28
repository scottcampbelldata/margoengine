/// <reference lib="esnext.disposable" preserve="true" />
// A CAD inspection bench: measured metal finishes for solids from a CAD kernel, crisp feature edges on both backends
// and a surface-plate deck under the part. It stages nothing else: open the engine, lights, shadows and backdrop with
// `@margoengine/studio/bench` (`openBench`) and pass its `add` here so shown parts cast.
//
// Sources (clean room, read as papers and standards):
// - glTF 2.0, ISO/IEC 12113:2022 (metallic-roughness model: a metal's base colour is its F0, section 3.9.2).
// - EXT_meshopt_compression (Khronos, 2021) and KHR_mesh_quantization: how the demo solids travel as GLB.
// - ISO 10303-21:2016 (STEP exchange structure): the B-rep faces whose shared boundaries are the edges drawn here.
// - T. Saito, T. Takahashi, "Comprehensible rendering of 3-D shapes", SIGGRAPH 1990: crease and outline lines make
//   shape readable where shading alone does not.
// - A. Gooch, B. Gooch, P. Shirley, E. Cohen, "A non-photorealistic lighting model for automatic technical
//   illustration", SIGGRAPH 1998: dark lines on crease edges over a shaded part, the technical-illustration standard.
// - T. Isenberg, B. Freudenberg, N. Halper, S. Schlechtweg, T. Strothotte, "A developer's guide to silhouette
//   algorithms for polygonal models", IEEE CG&A 23(4), 2003: dihedral-angle crease detection on a mesh.
// - J. A. Bærentzen, S. L. Nielsen, M. Gjøl, B. D. Larsen, "Two methods for antialiased wireframe drawing with hidden
//   line removal", SCCG 2008: depth-biased, coverage-antialiased lines over their own faces.
// - Metal F0 values: @margoengine/materials/presets (measured complex indices; each row cites its source).
import { box, PbrMaterial, type EngineKernel, type Geometry, type Mesh } from '@margoengine/core';
import { hexColor } from '@margoengine/math/color';
import { Line, LineMaterial, Lines } from '@margoengine/lines';
import { EdgesHelper } from '@margoengine/lines/edges';
import { castIron, metal, surface, type MaterialPreset, type MetalName } from '@margoengine/materials/presets';

type Vec3 = readonly [number, number, number];

/** How a part's surface was made. */
export type CadFinish = 'machined' | 'cast' | 'anodised' | 'cut';

/** One finish: the metal under it, its roughness and the tint on the metal's F0. */
export interface CadFinishSpec {
  /** Measured metal from `@margoengine/materials/presets`, or 'castIron' (iron F0 darkened by scale). */
  readonly metal: MetalName | 'castIron';
  /** Perceptual roughness 0..1. */
  readonly roughness: number;
  /** Linear multiplier on the metal's F0. */
  readonly tint: Vec3;
}

/**
 * The four finishes, frozen. machined: turned or milled aluminium bar stock (roughness 0.32). cast: sand-cast iron
 * with its scale (the castIron preset, 0.75). anodised: Type II sulphuric anodising dyed a steel blue, as tinted
 * aluminium F0 (0.4). cut: a fresh saw or section face in aluminium, brighter and smoother (0.16).
 */
export const CAD_FINISHES: Readonly<Record<CadFinish, CadFinishSpec>> = Object.freeze({
  machined: Object.freeze({ metal: 'aluminium', roughness: 0.32, tint: Object.freeze([1, 1, 1] as const) }),
  cast: Object.freeze({ metal: 'castIron', roughness: 0.75, tint: Object.freeze([1, 1, 1] as const) }),
  anodised: Object.freeze({ metal: 'aluminium', roughness: 0.4, tint: Object.freeze([0.22, 0.34, 0.5] as const) }),
  cut: Object.freeze({ metal: 'aluminium', roughness: 0.16, tint: Object.freeze([1, 1, 1] as const) }),
});

/** Edge lines of {@link CadBench.show}. */
export interface CadEdgeOptions {
  /** Dihedral angle in degrees above which an edge is drawn; open boundaries always are. Default 30. */
  angle?: number;
  /** Width in CSS pixels. Default 1.25. */
  width?: number;
  /** Colour, `#rgb`/`#rrggbb` or linear [r, g, b]. Default '#0c1013'. */
  color?: string | Vec3;
  /** 0..1. Default 0.82. */
  opacity?: number;
  /** Fraction of the eye distance the line is pulled forward so it never flickers into its faces. Default 0.0012. */
  depthBias?: number;
}

/** The deck of {@link CadBench}: a lapped surface plate under the part. */
export interface CadDeckOptions {
  /** Plate width (x) and depth (z) in metres. Default [0.42, 0.3]. */
  size?: readonly [number, number];
  /** Plate thickness in metres. Default 0.04. */
  thickness?: number;
  /** Height of the plate's top face. Default `thickness`: the plate rests on a floor at y 0 (studio/bench's cyclorama). */
  top?: number;
  /** Centre of the plate in x and z. Default [0, 0]. */
  center?: readonly [number, number];
  /** Plate material. Default black granite: basalt albedo (the diabase of metrology plates), lapped to roughness 0.5. */
  material?: PbrMaterial;
}

/** Something that registers shadow casters, such as studio/bench's `Bench`. */
export interface CadCasters {
  add(mesh: Mesh, options?: { shadow?: boolean; contact?: boolean; static?: boolean }): () => void;
}

/** Options of {@link CadBench.attach}. */
export interface CadBenchOptions {
  /** The surface plate; false for none. Default {@link CadDeckOptions} defaults. */
  deck?: CadDeckOptions | boolean;
  /** Default edge lines of every shown part; false draws none unless a `show` asks. Default {@link CadEdgeOptions} defaults. */
  edges?: CadEdgeOptions | boolean;
  /** Registers shown parts (and the deck, as a receiver only) for shadows; pass studio/bench's bench. Default none. */
  casters?: CadCasters;
  /** Lines plugin to draw edges with. Default a new one named 'cad-bench:lines'. */
  lines?: Lines;
}

/** Options of {@link CadBench.show}. */
export interface CadShowOptions {
  /** Default 'machined'. */
  finish?: CadFinish;
  /** Measured metal replacing the finish's (machined steel, cut copper); 'castIron' for scaled iron. Default the finish's. */
  metal?: MetalName | 'castIron';
  /** Linear [r, g, b] or `#rrggbb` replacing the finish's tint on the metal F0 (an anodising dye, say). */
  tint?: string | Vec3;
  /** Replaces the finish's roughness, 0..1. */
  roughness?: number;
  /** Edge lines; true takes the bench's, false none. Default the bench's. */
  edges?: CadEdgeOptions | boolean;
  /** Cast shadows through the bench's `casters`. Default true. */
  shadow?: boolean;
}

/** {@link CadBench.mark} options. */
export interface CadMarkOptions {
  /** Arm length of the cross in metres, each way from the point. Default 0.008. */
  size?: number;
  /** Colour, `#rgb`/`#rrggbb` or linear [r, g, b]. Default '#d2302a', a witness-mark red. */
  color?: string | Vec3;
  /** Width in CSS pixels. Default 2. */
  width?: number;
}
/** A point marked on the bench. */
export interface CadMark {
  readonly line: Line;
  /** Takes the mark off. Safe to repeat. */
  remove(): void;
}

/** A part on the bench. */
export interface CadPart {
  readonly mesh: Mesh;
  readonly finish: CadFinish;
  readonly material: PbrMaterial;
  /** Its feature edges, when drawn. */
  readonly edges: Line | null;
  /** Shows or hides the part and its edges. */
  visible: boolean;
  /** Takes the part off the bench: its edges and shadow registration go; the mesh stays unless `dispose` is true. */
  remove(dispose?: boolean): void;
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Linear rgb of `#rgb`, `#rrggbb` or a linear triple. */
function rgb(value: string | Vec3, what: string): [number, number, number] {
  if (typeof value === 'string') {
    const srgb = value.length === 9 ? undefined : hexColor(value);
    if (!srgb) throw new TypeError(`Invalid ${what}; pass #rgb, #rrggbb or linear [r, g, b]`);
    return [linear(srgb[0]), linear(srgb[1]), linear(srgb[2])];
  }
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => v >= 0 && v <= 1))
    throw new TypeError(`Invalid ${what}; pass #rgb, #rrggbb or linear [r, g, b] in 0..1`);
  return [value[0], value[1], value[2]];
}

/**
 * The PbrMaterial options of a finish: the metal's measured F0 times the tint, metalness 1. `metal` swaps the finish's
 * metal and keeps its roughness and tint: `cadFinish('machined', { metal: 'copper' })`.
 * @throws RangeError for an unknown finish or metal or a roughness outside 0..1; TypeError for a malformed tint.
 */
export function cadFinish(
  finish: CadFinish,
  { tint, roughness, metal: name }: Pick<CadShowOptions, 'tint' | 'roughness' | 'metal'> = {},
): MaterialPreset {
  const spec = Object.prototype.hasOwnProperty.call(CAD_FINISHES, finish) ? CAD_FINISHES[finish] : undefined;
  if (!spec) throw new RangeError(`Unknown finish '${String(finish)}'; pass machined, cast, anodised or cut`);
  const r = roughness ?? spec.roughness;
  if (!(r >= 0 && r <= 1)) throw new RangeError(`roughness must be 0 to 1, got ${r}`);
  const which = name ?? spec.metal,
    base = which === 'castIron' ? castIron : metal(which),
    t = tint === undefined ? spec.tint : rgb(tint, 'tint');
  return Object.freeze({
    color: Object.freeze([base.color[0] * t[0], base.color[1] * t[1], base.color[2] * t[2]] as const),
    roughness: r,
    metalness: base.metalness,
  });
}

const EDGE_DEFAULTS = { angle: 30, width: 1.25, color: '#0c1013', opacity: 0.82, depthBias: 0.0012 } as const;

/**
 * A CAD inspection bench on an engine: `show` gives a mesh or geometry a measured metal finish and feature edges.
 * Edges are `@margoengine/lines` segments, so they draw on WebGPU and on the WebGL2 compatibility layer alike.
 */
export class CadBench {
  readonly engine: EngineKernel;
  /** The surface plate, when the bench has one. */
  readonly deck: Mesh | null = null;
  /** Height of the plate's top face, where parts rest (0 without a deck). Move a model's root up by it. */
  readonly deckTop: number = 0;
  /** The Lines plugin the edges draw with. */
  readonly lines: Lines;
  private readonly parts = new Set<CadPart>();
  private readonly materials = new Map<string, PbrMaterial>();
  private readonly edgeDefaults: Required<CadEdgeOptions> | null;
  private readonly casters?: CadCasters;
  private readonly ownLines: boolean;
  private disposed = false;

  /**
   * Puts a bench on `engine`.
   * @example
   * const cad = CadBench.attach(engine, { deck: { size: [0.3, 0.2] } });
   * cad.show(engine.createMesh().setGeometry(box(0.1, 0.04, 0.06)), { finish: 'anodised' });
   */
  static attach(engine: EngineKernel, options: CadBenchOptions = {}): CadBench {
    return new CadBench(engine, options);
  }

  private constructor(engine: EngineKernel, options: CadBenchOptions) {
    if (!engine || typeof engine.createMesh !== 'function') throw new TypeError('CadBench.attach needs an engine');
    if (!options || typeof options !== 'object') throw new TypeError('Invalid CadBench options; pass an object');
    this.engine = engine;
    this.casters = options.casters;
    this.edgeDefaults =
      options.edges === false ? null : edgeOptions(options.edges === true ? {} : (options.edges ?? {}));
    if (options.deck !== false) {
      const deck = options.deck === true ? {} : (options.deck ?? {});
      this.deck = this.makeDeck(deck);
      this.deckTop = deck.top ?? deck.thickness ?? 0.04;
    }
    this.ownLines = !options.lines;
    this.lines = options.lines ?? Lines.attach(engine, { name: 'cad-bench:lines' });
  }

  private makeDeck({
    size = [0.42, 0.3],
    thickness = 0.04,
    top = thickness,
    center = [0, 0],
    material,
  }: CadDeckOptions): Mesh {
    if (!(size[0] > 0 && size[1] > 0 && thickness > 0) || ![top, center[0], center[1]].every(Number.isFinite))
      throw new RangeError('Invalid deck; pass a positive size and thickness and a finite top and center');
    const granite = surface('basalt', { roughness: 0.5 }),
      plate = material ?? new PbrMaterial({ color: granite.color, roughness: granite.roughness });
    const mesh = this.engine
      .createMesh()
      .setGeometry(box(size[0], thickness, size[1]))
      .setMaterial(plate)
      .setPosition([center[0], top - thickness / 2, center[1]]);
    mesh.name = 'cad-bench:deck';
    return mesh;
  }

  /** A finish's material, shared by every part with the same finish, tint and roughness. */
  material(finish: CadFinish, options: Pick<CadShowOptions, 'tint' | 'roughness' | 'metal'> = {}): PbrMaterial {
    const preset = cadFinish(finish, options),
      key = `${preset.color.join(',')}|${preset.roughness}`;
    let value = this.materials.get(key);
    if (!value)
      this.materials.set(
        key,
        (value = new PbrMaterial({
          color: preset.color,
          roughness: preset.roughness,
          metalness: preset.metalness,
          doubleSided: false,
        })),
      );
    return value;
  }

  /**
   * Puts a part on the bench: a mesh (from a glTF model, say) keeps its geometry and takes the finish; a geometry gets
   * a new mesh. Its feature edges follow the mesh.
   * @throws TypeError for a mesh without geometry or after dispose; what {@link cadFinish} throws.
   */
  show(source: Mesh | Geometry, options: CadShowOptions = {}): CadPart {
    if (this.disposed) throw new TypeError('This CadBench is disposed');
    const { finish = 'machined', shadow = true } = options,
      material = this.material(finish, options),
      created = !isMesh(source),
      mesh = created ? this.engine.createMesh().setGeometry(source as Geometry) : (source as Mesh);
    const geometry = mesh.geometry;
    if (!geometry) throw new TypeError('CadBench.show needs a mesh with geometry');
    mesh.setMaterial(material);
    const style =
      options.edges === false
        ? null
        : options.edges === true || options.edges === undefined
          ? this.edgeDefaults
          : edgeOptions({ ...(this.edgeDefaults ?? {}), ...options.edges });
    let edges: Line | null = null;
    if (style) {
      edges = new EdgesHelper(geometry, {
        angle: style.angle,
        mesh,
        material: new LineMaterial({
          color: style.color as string | [number, number, number],
          width: style.width,
          opacity: style.opacity,
          depthBias: style.depthBias,
        }),
      });
      this.lines.add(edges);
    }
    const unregister = shadow ? this.casters?.add(mesh, { shadow: true, contact: true }) : undefined;
    const lines = this.lines,
      parts = this.parts,
      part: CadPart = {
        mesh,
        finish,
        material,
        edges,
        get visible() {
          return mesh.visible;
        },
        set visible(value: boolean) {
          mesh.visible = value;
          if (edges) edges.visible = value;
        },
        remove(dispose = false) {
          if (!parts.delete(part)) return;
          if (edges) lines.remove(edges);
          unregister?.();
          if (dispose || created) mesh.dispose();
        },
      };
    parts.add(part);
    return part;
  }

  /**
   * Marks a point (a centre of mass, a datum, a probe hit) with a three-axis cross drawn through the bench's Lines.
   * @throws RangeError for a non-finite point or a size or width that is not positive.
   * @example const mark = cad.mark([0, 0.02, 0]); // later: mark.remove()
   */
  mark(point: Vec3, { size = 0.008, color = '#d2302a', width = 2 }: CadMarkOptions = {}): CadMark {
    if (this.disposed) throw new TypeError('This CadBench is disposed');
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite))
      throw new RangeError('mark needs a finite [x, y, z] point');
    if (!(size > 0 && Number.isFinite(size))) throw new RangeError('Mark size must be positive');
    if (!(width > 0 && width <= 64)) throw new RangeError('Mark width must be above 0 and at most 64 pixels');
    const [x, y, z] = point,
      line = new Line({
        mode: 'segments',
        positions: [x - size, y, z, x + size, y, z, x, y - size, z, x, y + size, z, x, y, z - size, x, y, z + size],
        material: new LineMaterial({
          color: typeof color === 'string' ? color : rgb(color, 'mark colour'),
          width,
          depthBias: EDGE_DEFAULTS.depthBias,
        }),
      });
    this.lines.add(line);
    const lines = this.lines;
    let removed = false;
    return {
      line,
      remove() {
        if (removed) return;
        removed = true;
        lines.remove(line);
      },
    };
  }

  /** The parts on the bench, in the order shown. */
  get shown(): readonly CadPart[] {
    return [...this.parts];
  }

  /** Removes every part (disposing meshes the bench made), the deck and the bench's own Lines plugin. Safe to repeat. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const part of [...this.parts]) part.remove();
    this.deck?.dispose();
    if (this.ownLines) this.engine.removePlugin?.(this.lines.name);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

function isMesh(value: unknown): value is Mesh {
  return !!value && typeof (value as Mesh).setGeometry === 'function';
}

function edgeOptions(o: CadEdgeOptions): Required<CadEdgeOptions> {
  const v = { ...EDGE_DEFAULTS, ...o };
  if (!(v.angle >= 0 && v.angle <= 180)) throw new RangeError('Edge angle must be 0 to 180 degrees');
  if (!(v.width > 0 && v.width <= 64)) throw new RangeError('Edge width must be above 0 and at most 64 pixels');
  if (!(v.opacity >= 0 && v.opacity <= 1)) throw new RangeError('Edge opacity must be 0 to 1');
  if (!(v.depthBias >= 0 && v.depthBias < 1)) throw new RangeError('Edge depthBias must be 0 up to 1');
  return { ...v, color: typeof v.color === 'string' ? v.color : rgb(v.color, 'edge colour') };
}
