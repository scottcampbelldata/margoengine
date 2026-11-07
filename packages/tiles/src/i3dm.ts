// @margoengine/tiles/i3dm: draws Instanced 3D Model (i3dm) tile content, such as trees, poles and street furniture,
// as one instanced draw per glTF primitive. Pass `i3dm` to `TilesRenderer.load`; tilesets without i3dm never load
// this module. Written from the 3D Tiles 1.0 i3dm specification (instance transforms, RTC_CENTER, y-up glTF).
import type { Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import type { InstancesContent } from './formats.js';
import { type TileMatrix, Y_UP_TO_Z_UP, invert, multiply, translation } from './matrix.js';
import type { TilesContentHost, TilesInstancesDrawer, TilesModel } from './renderer.js';
import type { TileRenderable, TilesetTile } from './tileset.js';

/** An engine mesh with its world matrix (the engine's Mesh class has it; the Mesh interface leaves it out). */
type Node = Mesh & { readonly matrix: Float32Array };

/** The part of a gltf-pro model (`PBRModel`) the i3dm drawer needs: its primitives and their nodes. */
interface InstancedModel extends TilesModel {
  readonly root: Node;
  readonly primitives: readonly { node: Node; instances?: unknown }[];
}

interface Rows {
  setMatrixAt(i: number, m: ArrayLike<number>): unknown;
}

/**
 * Node-space matrices for every instance of one glTF node: the i3dm instance transform `I_i` (tileset z-up, relative
 * to `center`), after the glTF y-up to z-up turn, moved into the node's own space so that
 * `root x N x J_i = root x translate(center) x I_i x Y_UP_TO_Z_UP x N`, where the model root sits at
 * `translate(center)` and `N` is the node's matrix in the model. Returns 16 float64 values per instance.
 */
export function instanceMatrices(
  matrices: ArrayLike<number>,
  node: ArrayLike<number>,
  center: ArrayLike<number> = [0, 0, 0],
): Float64Array {
  const n = Math.floor(matrices.length / 16),
    out = new Float64Array(n * 16),
    inverseNode = invert(node),
    back = translation(-center[0], -center[1], -center[2]),
    turnNode = multiply(Y_UP_TO_Z_UP, node),
    m = new Float64Array(16),
    t = new Float64Array(16);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 16; k++) m[k] = matrices[i * 16 + k];
    multiply(back, m, t);
    multiply(t, turnNode, t);
    multiply(inverseNode, t, t);
    out.set(t, i * 16);
  }
  return out;
}

/** Mean instance position (float64) of i3dm instance matrices: where the model root is placed, so float32 rows stay small. */
export function instanceCenter(matrices: ArrayLike<number>): [number, number, number] {
  const n = Math.floor(matrices.length / 16);
  const c: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += matrices[i * 16 + 12 + k] / n;
  return c;
}

/**
 * Draws i3dm content: pass it as `TilesRenderer.load(engine, url, { i3dm })`. Each primitive of the instanced glTF
 * draws all `INSTANCES_LENGTH` instances in one instanced draw (gltf-pro's `PBRInstances`). An external glTF
 * (`gltfFormat` 0) is fetched with the tileset's own fetch, relative to the tile's content URL.
 */
export const i3dm: TilesInstancesDrawer = async (
  host: TilesContentHost,
  content: InstancesContent,
  tile: TilesetTile,
  signal: AbortSignal,
): Promise<TileRenderable> => {
  if (!content.length) return { bytes: content.byteLength, get visible() {
        return false;
      },
      set visible(_value: boolean) {},
      dispose() {},
    };
  const gltf =
    content.gltf ?? (await host.fetch(new URL(content.gltfUri!, tile.contentUrls[0] ?? host.url).href, signal));
  const [{ PBRInstances }, model] = await Promise.all([
    import('@margoengine/gltf-pro/instancing'),
    host.loadModel(gltf, signal) as Promise<InstancedModel>,
  ]);
  try {
    signal.throwIfAborted();
    if (!Array.isArray(model.primitives))
      throw new MargoError(
        'unsupported',
        'i3dm needs a model with primitives (gltf-pro); a custom loadModel must return a gltf-pro PBRModel',
      );
    const center = instanceCenter(content.matrices),
      root = model.root,
      rtc = content.rtcCenter ?? [0, 0, 0];
    root.check();
    const inverseRoot = invert(root.matrix),
      byNode = new Map<Mesh, Rows>();
    for (const primitive of model.primitives) {
      let rows = byNode.get(primitive.node);
      if (!rows) {
        primitive.node.check();
        const node: TileMatrix = multiply(inverseRoot, primitive.node.matrix),
          local = instanceMatrices(content.matrices, node, center),
          made = new PBRInstances(content.length);
        made.setMatrices(0, local);
        byNode.set(primitive.node, (rows = made));
      }
      primitive.instances = rows;
    }
    host.place(
      root,
      host.contentMatrix(tile, [rtc[0] + center[0], rtc[1] + center[1], rtc[2] + center[2]], false),
    );
    root.visible = false;
  } catch (error) {
    model.dispose();
    throw error;
  }
  return {
    bytes: content.byteLength,
    get visible() {
      return model.root.visible;
    },
    set visible(value: boolean) {
      model.root.visible = value;
    },
    dispose: () => {
      host.forget(model.root);
      model.dispose();
    },
  };
};
