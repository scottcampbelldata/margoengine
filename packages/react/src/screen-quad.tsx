import { forwardRef, useEffect, useRef, useState } from 'react';
import type { RawMesh, RawShaders } from '@margoengine/shader/raw';
import type { ShaderMaterial, ShaderMaterialOptions, ShaderUniform } from '@margoengine/shader/glsl-material';
import { assignRef, report, useCommit, useScene, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';
import { fault, typeError } from '../../shared/errors.js';

type Owner = NonNullable<Scene['world']> | Scene['engine'];
interface RawLease {
  users: number;
  promise: Promise<RawShaders>;
}
// One RawShaders per scene, shared by every ScreenQuad in it and removed with the last one.
const leases = new WeakMap<Owner, RawLease>();
let serial = 0;
function acquire(scene: Scene): RawLease {
  const owner: Owner = scene.world ?? scene.engine;
  let lease = leases.get(owner);
  if (!lease) {
    lease = {
      users: 0,
      promise: optionalPeer('@margoengine/shader', () => import('@margoengine/shader/raw')).then((api) => {
        if (scene.engine.disposed)
          throw fault('disposed', 'Canvas is disposed; render the component inside a live <Canvas>', 'react-usage');
        const raw = new api.RawShaders({ name: `margoengine-react:screen-quad:${++serial}` });
        owner.use(raw);
        return raw;
      }),
    };
    leases.set(owner, lease);
  }
  lease.users++;
  return lease;
}
function release(scene: Scene, lease: RawLease): void {
  if (--lease.users) return;
  const owner: Owner = scene.world ?? scene.engine;
  queueMicrotask(() => {
    if (lease.users || leases.get(owner) !== lease) return;
    leases.delete(owner);
    void lease.promise.then(
      (raw) => {
        if (!scene.engine.disposed && owner.plugins.get(raw.name) === raw) owner.removePlugin(raw.name);
      },
      () => {},
    );
  });
}

/** The vertex stage `<ScreenQuad>` uses when it builds the material: `vUv` from 0 to 1 across the screen, y up. */
export const screenQuadVertexShader = `attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
// One triangle that covers the clip square: x and y run -1 to 3, so the screen is its lower-left quarter, where uv
// runs 0 to 1. One triangle has no diagonal seam where two would meet.
const positions = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]),
  uvs = new Float32Array([0, 0, 2, 0, 0, 2]);
const same = (a: unknown, b: unknown): boolean =>
  a === b ||
  (Array.isArray(a) &&
    (Array.isArray(b) || ArrayBuffer.isView(b)) &&
    a.length === (b as ArrayLike<number>).length &&
    a.every((v, i) => v === (b as ArrayLike<number>)[i]));
/** Props of `<ScreenQuad>`: a GLSL material, or the options to build one. */
export interface ScreenQuadProps extends Partial<Omit<ShaderMaterialOptions, 'uniforms'>> {
  /**
   * The material, a `ShaderMaterial` of `@margoengine/shader/glsl-material` whose vertex stage reads `position` (x and y
   * from -1 to 3) and `uv`. Default: one built from `fragmentShader` (required then), `screenQuadVertexShader` (or
   * `vertexShader`), `uniforms` and the other options; changing one of those options builds it again.
   */
  material?: ShaderMaterial;
  /** Uniforms of the built material by GLSL name; a `value` is copied into the material when it changes. */
  uniforms?: Record<string, ShaderUniform>;
  /** Lower draws first within the opaque or transparent group. Default 0. */
  renderOrder?: number;
  /** Default true. */
  visible?: boolean;
  onError?: (error: unknown) => void;
}
/**
 * A single triangle that covers the whole screen, drawn by a GLSL material, as drei's ScreenQuad: for backgrounds,
 * full-screen shader art and overlays. It is a RawMesh of `@margoengine/shader/raw` in a RawShaders plugin shared by
 * every ScreenQuad of the scene, never frustum culled. The ref is the RawMesh; its `material.uniforms` are live.
 * Depth and blending are the material's (`depthTest`, `depthWrite`, `transparent`, `blending`).
 */
export const ScreenQuad = /* @__PURE__ */ forwardRef<RawMesh<ShaderMaterial>, ScreenQuadProps>(
  function ScreenQuad(props, ref) {
    const scene = useScene(),
      [mesh, setMesh] = useState<RawMesh<ShaderMaterial> | null>(null),
      latest = useRef(props),
      handle = useRef(ref);
    latest.current = props;
    handle.current = ref;
    const { material, uniforms, renderOrder = 0, visible = true, onError: _onError, ...options } = props,
      // The built material's options count by value; functions and objects other than plain data by identity.
      key = material ? null : JSON.stringify(options);
    useEffect(() => {
      let active = true,
        current: RawMesh<ShaderMaterial> | undefined,
        owned: ShaderMaterial | undefined,
        raw: RawShaders | undefined;
      const lease = acquire(scene);
      Promise.all([
        lease.promise,
        optionalPeer('@margoengine/shader', () => import('@margoengine/shader/glsl-material')),
      ])
        .then(([plugin, api]) => {
          if (!active || scene.engine.disposed) return;
          raw = plugin;
          const {
            material: given,
            uniforms: values,
            renderOrder: order = 0,
            visible: shown = true,
            onError: _,
            ...built
          } = latest.current;
          if (!given && !built.fragmentShader)
            throw typeError('ScreenQuad needs a material or a fragmentShader; pass one of them', 'react-arguments');
          const surface =
            given ??
            (owned = new api.ShaderMaterial({
              vertexShader: screenQuadVertexShader,
              ...built,
              fragmentShader: built.fragmentShader!,
              uniforms: values,
            }));
          current = api.shaderMesh({ positions, uvs }, surface, {
            frustumCulled: false,
            renderOrder: order,
            visible: shown,
          });
          raw.add(current);
          assignRef(handle.current, current);
          setMesh(current);
        })
        .catch((error) => {
          if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
        });
      return () => {
        active = false;
        if (current) {
          const made = current;
          assignRef(handle.current, null);
          setMesh((state) => (state === made ? null : state));
          raw?.remove(made);
          made.dispose();
        }
        owned?.dispose();
        release(scene, lease);
      };
    }, [scene.engine, scene.world, material, key]);
    // A uniform's value is copied in when the prop's value changes, so a value the ref's live uniforms moved on (a clock
    // advanced in useFrame) is not put back by an unrelated render. Arrays count by their numbers.
    const copied = useRef(new Map<string, unknown>());
    useCommit(() => {
      if (!mesh) return;
      mesh.renderOrder = renderOrder;
      mesh.visible = visible;
      if (material || !uniforms) return;
      for (const [name, { value }] of Object.entries(uniforms)) {
        const target = mesh.material.uniforms[name],
          last = copied.current.get(name);
        if (!target || same(last, value)) continue;
        target.value = value;
        copied.current.set(
          name,
          Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value as ArrayLike<number>) : value,
        );
      }
    });
    useEffect(() => () => copied.current.clear(), [mesh]);
    return null;
  },
);
