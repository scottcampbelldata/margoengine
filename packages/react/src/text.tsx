import { Children, forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { Geometry, Mesh as EngineMesh } from '@margoengine/core/extension';
import type { Text as TextBlock, TextOptions, TextRenderer, Font } from '@margoengine/text';
import type { ExtrudeTextOptions, FontLike, FontOutlines } from '@margoengine/text/extrude';
import { Mesh, PbrMaterial, type MeshProps, type MeshRef, type PbrMaterialProps } from './components.js';
import {
  useScene,
  useCommit,
  useLiveRef,
  useMesh,
  live,
  setGeometry,
  assignRef,
  zero,
  report,
  type Scene,
} from './internal.js';
import { optionalPeer } from './optional.js';
import { fault } from '../../shared/errors.js';
import { sceneOwner } from './scene-owner.js';

interface ErrorProps {
  onError?: (error: unknown) => void;
}

interface TextRendererLease {
  users: number;
  promise: Promise<{ renderer: TextRenderer; api: typeof import('@margoengine/text') }>;
}
// One renderer per scene the Text sits in: the enclosing <Scene>'s world, else the engine's default scene.
const renderers = new WeakMap<object, TextRendererLease>();
function acquireTextRenderer(scene: Scene): TextRendererLease {
  let entry = renderers.get(sceneOwner(scene));
  if (!entry) {
    entry = {
      users: 0,
      promise: optionalPeer('@margoengine/text', () => import('@margoengine/text')).then((api) => {
        if (scene.engine.disposed)
          throw fault('disposed', 'Canvas is disposed; render the component inside a live <Canvas>', 'react-usage');
        const renderer = new api.TextRenderer({ name: 'margoengine-react:text' });
        sceneOwner(scene).use(renderer);
        return { renderer, api };
      }),
    };
    renderers.set(sceneOwner(scene), entry);
  }
  entry.users++;
  return entry;
}
function releaseTextRenderer(scene: Scene, entry: TextRendererLease): void {
  if (--entry.users) return;
  queueMicrotask(() => {
    if (entry.users || renderers.get(sceneOwner(scene)) !== entry) return;
    renderers.delete(sceneOwner(scene));
    void entry.promise.then(
      ({ renderer }) => {
        sceneOwner(scene).removePlugin(renderer.name);
        renderer.dispose();
      },
      () => {},
    );
  });
}
/** Props of the Text component; every prop is optional unless noted. */
export interface TextProps extends Omit<TextOptions, 'mesh' | 'text'>, ErrorProps {
  text?: string;
  children?: string | number;
}
const textDefaults = {
  fontSize: 1,
  lineHeight: 1.2,
  letterSpacing: 0,
  maxWidth: Infinity,
  textAlign: 'left',
  anchorX: 'left',
  anchorY: 'top',
  direction: 'auto',
  whiteSpace: 'normal',
  overflowWrap: 'break-word',
  color: 0xffffff,
  opacity: 1,
  outlineWidth: 0,
  outlineColor: 0,
  outlineOpacity: 1,
  shadowColor: 0,
  shadowOpacity: 0,
  shadowBlur: 0,
  billboard: false,
  onTop: false,
} as const;
/** The text component. */
export const Text = /* @__PURE__ */ forwardRef<TextBlock, TextProps>(function Text(props, ref) {
  const scene = useScene(),
    latest = useRef(props),
    [item, setItem] = useState<TextBlock | null>(null),
    handle = useRef(ref);
  handle.current = ref;
  latest.current = props;
  const font = useRef<{ input: TextOptions['font']; value: Font } | null>(null),
    apply = useRef<(text: TextBlock) => void>(() => {});
  useEffect(() => {
    let active = true,
      current: TextBlock | undefined,
      renderer: TextRenderer | undefined;
    const entry = acquireTextRenderer(scene),
      attach = (mesh: EngineMesh) => current?.attach(mesh as unknown as MeshHandle);
    entry.promise
      .then(({ renderer: loaded, api }) => {
        if (!active || scene.engine.disposed) return;
        renderer = loaded;
        apply.current = (text) => {
          const {
            children,
            text: content = String(children ?? ''),
            font: input,
            visible = true,
            position = zero,
            rotation = zero,
            scale = 1,
            matrix,
            onError,
            ...style
          } = latest.current;
          if (!font.current || font.current.input !== input)
            font.current = { input, value: input instanceof api.Font ? input : new api.Font(input) };
          text.set({
            ...textDefaults,
            shadowOffset: [0.04 * (style.fontSize ?? 1), -0.04 * (style.fontSize ?? 1)],
            ...style,
            text: content,
            font: font.current.value,
          });
          text.visible = visible;
          if (matrix) text.setMatrix(matrix);
          else text.setTransform(position, rotation, scale);
          text.attach((scene.registry?.current as unknown as MeshHandle) ?? null);
        };
        current = new api.Text();
        apply.current(current);
        renderer.add(current);
        scene.registry?.attachments.add(attach);
        assignRef(handle.current, current);
        setItem(current);
      })
      .catch((error) => {
        if (current) renderer?.remove(current);
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
      scene.registry?.attachments.delete(attach);
      if (current) {
        const made = current;
        assignRef(handle.current, null);
        setItem((state) => (state === made ? null : state));
        renderer?.remove(made);
      }
      releaseTextRenderer(scene, entry);
    };
  }, [scene.engine, scene.world, scene.registry]);
  useCommit(() => {
    if (item) apply.current(item);
  });
  useLiveRef(ref, item);
  return null;
});

type ExtrudeApi = typeof import('@margoengine/text/extrude');
/** Font of `<Text3D>`: a TTF or OTF URL, its bytes, parsed `FontOutlines` or any `FontLike`. */
export type Text3DFont = string | URL | ArrayBuffer | ArrayBufferView | FontOutlines | FontLike;
/** Props of `<Text3D>`: the extrusion options of `extrudeText` from `@margoengine/text/extrude`, the Mesh props and a colour. */
export interface Text3DProps
  extends Omit<ExtrudeTextOptions, 'font' | 'shapedRuns'>,
    Pick<MeshProps, 'position' | 'rotation' | 'scale' | 'castShadow' | 'receiveShadow' | 'layers'>,
    Pick<PbrMaterialProps, 'color' | 'roughness' | 'metalness'>,
    ErrorProps {
  /** The font: a TTF or OTF URL (fetched once per URL and shared), its bytes, parsed `FontOutlines` or a `FontLike`. Required. */
  font: Text3DFont;
  /** drei's name for `depth`, the extrusion along +Z. */
  height?: number;
  /** The text; else the string and number children. */
  text?: string;
  /** Text (strings and numbers) and other children, such as a material, which go inside the mesh. */
  children?: ReactNode;
  /**
   * drei's `smooth`: when set, every vertex's normal is the average of the faces around its position (positions within
   * this distance count as one), so the edges between the caps, bevel and sides shade round. Default: unset, the
   * extruder's own normals (flat caps and sides). Uses `creasedNormals` of `@margoengine/geometry/utils`.
   */
  smooth?: number;
  /** With `smooth`, faces more than this many degrees apart keep their own normals, so sharp corners stay sharp. Default 180 (all round). */
  smoothAngle?: number;
  /** Called with the geometry's bounding box once it is built. */
  onBuild?: (bounds: { min: [number, number, number]; max: [number, number, number] }) => void;
}
/**
 * The OpenType readers of `@margoengine/loaders/font-opentype`, loaded only for a CFF ('OTTO') file or a variable
 * instance; TrueType fonts at their default instance extrude without them.
 */
async function readersFor(bytes: ArrayBuffer | ArrayBufferView | null, variations: object | undefined) {
  const head = !bytes
    ? null
    : ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(4, bytes.byteLength))
      : new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  const cff = !!head && String.fromCharCode(...head) === 'OTTO';
  if (!cff && !(variations && Object.keys(variations).length)) return undefined;
  return (await optionalPeer('@margoengine/loaders', () => import('@margoengine/loaders/font-opentype'))).openType;
}
const fonts = new Map<string, Promise<FontOutlines>>();
function loadFont(api: ExtrudeApi, url: string, variations: object | undefined): Promise<FontOutlines> {
  const cacheKey = `${variations && Object.keys(variations).length ? 'varied ' : ''}${url}`;
  let font = fonts.get(cacheKey);
  if (!font) {
    font = fetch(url)
      .then((response) => {
        if (!response.ok)
          throw fault(
            'failed',
            `Text3D: ${url} answered ${response.status}; pass the URL of a TTF or OTF font`,
            'react-usage',
          );
        return response.arrayBuffer();
      })
      .then(async (bytes) => api.parseFontOutlines(bytes, { openType: await readersFor(bytes, variations) }));
    fonts.set(cacheKey, font);
    // A failed load is not kept, so a later mount can try again.
    font.catch(() => fonts.delete(cacheKey));
  }
  return font;
}
function Text3DGeometry({ text, options }: { text: string; options: Omit<Text3DProps, 'children' | 'text'> }) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef(options);
  latest.current = options;
  const {
      font,
      height,
      onError,
      onBuild,
      smooth,
      smoothAngle = 180,
      position,
      rotation,
      scale,
      castShadow,
      receiveShadow,
      layers,
      color,
      roughness,
      metalness,
      ...extrusion
    } = options,
    url = typeof font === 'string' || font instanceof URL ? String(font) : null;
  const key = JSON.stringify([text, url, height, smooth, smoothAngle, extrusion]);
  // Bytes and parsed fonts count by identity: a new one rebuilds the text.
  const fontObject = url === null ? font : null;
  useEffect(() => {
    let active = true,
      geometry: Geometry | undefined;
    const attach = (mesh: EngineMesh) => {
      if (geometry) setGeometry(registry, mesh, geometry);
    };
    // Core is loaded here, not at the top, so the entry's Text alone does not reach for the Geometry class.
    Promise.all([
      optionalPeer('@margoengine/text', () => import('@margoengine/text/extrude')),
      import('@margoengine/core/extension'),
    ])
      .then(async ([api, core]) => {
        const source =
          url !== null
            ? await loadFont(api, url, extrusion.variations)
            : (fontObject as Exclude<Text3DFont, string | URL>);
        const bytes = source instanceof ArrayBuffer || ArrayBuffer.isView(source) ? source : null,
          openType = bytes ? await readersFor(bytes, extrusion.variations) : undefined;
        if (!active || scene.engine.disposed) return;
        const { height: alias, depth = alias, onBuild: built } = latest.current,
          data = api.extrudeText(text, {
            ...extrusion,
            ...(depth === undefined ? {} : { depth }),
            font: source,
            openType,
          });
        if (smooth !== undefined) {
          const utils = await optionalPeer('@margoengine/geometry', () => import('@margoengine/geometry/utils'));
          if (!active || scene.engine.disposed) return;
          data.normals.set(
            utils.creasedNormals(data.positions, { indices: data.indices, tolerance: smooth, angle: smoothAngle }),
          );
        }
        geometry = data.toGeometry(core.Geometry) as Geometry;
        registry.attachments.add(attach);
        const mesh = live(registry);
        if (mesh) attach(mesh);
        built?.(data.boundingBox);
      })
      .catch((cause) => {
        if (active && !scene.engine.disposed) report(scene, cause, latest.current.onError);
      });
    return () => {
      active = false;
      registry.attachments.delete(attach);
      const mesh = live(registry);
      if (mesh && registry.geometry === geometry) setGeometry(registry, mesh, null);
    };
  }, [scene.engine, registry, key, fontObject]);
  return null;
}
/**
 * Extruded 3D text from a TTF or OTF font, as drei's Text3D: `extrudeText` of `@margoengine/text/extrude` with its size,
 * depth (or drei's `height`), bevel, curve segments, letter spacing, line height and alignment. Strings in `children`
 * are the text; other children (a material) go inside the mesh. The ref is the mesh.
 */
export const Text3D = /* @__PURE__ */ forwardRef<MeshRef, Text3DProps>(function Text3D(props, ref) {
  const { children, text, position, rotation, scale, castShadow, receiveShadow, layers, color, roughness, metalness } =
      props,
    parts = Children.toArray(children),
    content = text ?? parts.filter((part) => typeof part === 'string' || typeof part === 'number').join(''),
    rest = parts.filter((part) => typeof part !== 'string' && typeof part !== 'number'),
    { children: _children, text: _text, ...options } = props;
  return (
    <Mesh
      ref={ref}
      position={position}
      rotation={rotation}
      scale={scale}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
      layers={layers}
    >
      <Text3DGeometry text={content} options={options} />
      {(color !== undefined || roughness !== undefined || metalness !== undefined) && (
        <PbrMaterial color={color} roughness={roughness} metalness={metalness} />
      )}
      {rest}
    </Mesh>
  );
});
