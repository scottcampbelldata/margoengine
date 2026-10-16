import type {Mesh} from '@margoengine/core/extension';

/** Optional CPU geometry protocol on loader-owned nodes, keyed by
 * Symbol.for('margoengine.pbr-source.v1'). Never installed on core Geometry. */
export interface PBRSource {
  readonly root: Mesh;
  readonly nodes: readonly Mesh[];
  readonly primitives: readonly PBRSourcePrimitive[];
  readonly asset: {
    readonly doc: Record<string, any>;
    accessor(index: unknown, type?: string): Float32Array;
  };
}

export interface PBRSourcePrimitive {
  readonly node: Mesh;
  readonly nodeIndex: number;
  /** Bind-pose position4, normal4, tangent4, UV0/UV1, color4 (20 floats). */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly definition: any;
  readonly extension?: unknown;
  readonly material: {
    readonly base: number[];
    readonly factors: number[];
    readonly emission: number[];
    readonly settings: number[];
    readonly maps: any[];
    readonly [key: string]: any;
  };
  readonly weights: Float32Array;
  readonly targetNames: readonly string[];
}
