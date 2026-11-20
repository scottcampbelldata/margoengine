import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Geometry } from '@margoengine/core/extension';
import type { GeometryData } from '@margoengine/geometry';
import type { LoadedSVG } from '@margoengine/loaders/svg';
import { GeometryResource, Mesh, PbrMaterial, type MeshProps, type MeshRef } from './components.js';
import { report, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { geometrySources } from './texture-geometry.js';
import { TextureMaterial, type TextureMaterialProps } from './texture-material.js';
import { fault } from '../../shared/errors.js';

/** Material options of an `<Svg>` fill or stroke: any `@margoengine/materials` option, applied over the defaults. */
export type SvgMaterialProps = Omit<TextureMaterialProps, 'geometry' | 'onError' | 'renderOrder'>;
/** Props of the mesh of each fill or stroke: transform, shadows and pointer handlers. */
export type SvgMeshProps = Omit<MeshProps, 'children'>;
/** Props of `<Svg>`: the drawing, which parts to draw, their materials and mesh props, and the group's Mesh props. */
export interface SvgProps extends Omit<MeshProps, 'children'> {
  /** The drawing: a URL (fetched) or SVG markup (any string starting with `<`). Required. */
  src: string | URL;
  /** Leave out the fills. Default false. */
  skipFill?: boolean;
  /** Leave out the strokes. Default false. */
  skipStrokes?: boolean;
  /** Options over every fill's material (default: unlit, the path's fill colour and opacity, transparent, no depth write, both sides). */
  fillMaterial?: SvgMaterialProps;
  /** Options over every stroke's material (defaults as `fillMaterial`, with the stroke's colour and opacity). */
  strokeMaterial?: SvgMaterialProps;
  /** Props of every fill's mesh. */
  fillMeshProps?: SvgMeshProps;
  /** Props of every stroke's mesh. */
  strokeMeshProps?: SvgMeshProps;
  /** Negate y so the drawing is upright in a y-up world (SVG's y axis points down). Default false, as drei's Svg. */
  flipY?: boolean;
  /** Straight pieces per curve of a fill. Default 12. */
  curveSegments?: number;
  /** Straight pieces per curve of a stroke, and per quarter turn of a round join or cap. Default 12. */
  strokeDivisions?: number;
  /** Called with the parsed drawing (paths, viewBox, size and warnings) once it is built. */
  onLoad?: (svg: LoadedSVG) => void;
  onError?: (error: unknown) => void;
  /** Other children, placed in the group with the drawing. */
  children?: ReactNode;
}
interface Part {
  stroke: boolean;
  geometry: Geometry;
  color: string;
  opacity: number;
  /** Offset toward +z on the small WebGL2 preview, which keeps document order there with depth (0 elsewhere). */
  layer: number;
}
/**
 * Depth step between parts on the small WebGL2 preview: 1/1000 of the drawing's extent, the whole stack held within
 * 5% of it. The preview draws lit, opaque core meshes with a depth test and no draw order, so later parts sit nearer +z.
 */
const layerStep = (extent: number, parts: number) => extent * Math.min(1e-3, 0.05 / Math.max(1, parts));
const extentOf = (data: readonly GeometryData[]) => {
  const low = [Infinity, Infinity],
    high = [-Infinity, -Infinity];
  for (const { positions } of data)
    for (let i = 0; i < positions.length; i += 3)
      for (let axis = 0; axis < 2; axis++) {
        low[axis] = Math.min(low[axis], positions[i + axis]);
        high[axis] = Math.max(high[axis], positions[i + axis]);
      }
  return Math.max(high[0] - low[0], high[1] - low[1], 0);
};
const hex = (rgb: readonly number[]) =>
  `#${rgb
    .map((value) =>
      Math.round(Math.min(1, Math.max(0, value)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
/** The small WebGL2 preview (`backend: 'webgl2'`): it draws core meshes with core's lit material only. */
const previewOnly = (engine: { backend: string; gpu: unknown }) => engine.backend === 'webgl2' || !engine.gpu;
const markup = (src: string | URL): src is string => typeof src === 'string' && src.trimStart().startsWith('<');
/**
 * An SVG drawing as flat meshes, as drei's Svg: each path's fill (`toShapes` of `@margoengine/loaders/svg` through
 * `shapeGeometry`) and stroke (`toStrokeGeometry`, with its joins, caps and miter limit) is one mesh in a group, in
 * document order, in the drawing's own units (SVG user units, y down unless `flipY`). Fills and strokes are unlit and
 * transparent with their SVG colour and opacity, painted in document order. Gradients draw in their average colour
 * and dashes solid (see the loader's `warnings`). On the small WebGL2 preview each part is a lit, opaque core mesh, a
 * step nearer +z per part to keep document order. The ref is the group's mesh.
 */
export const Svg = /* @__PURE__ */ forwardRef<MeshRef, SvgProps>(function Svg(
  {
    src,
    skipFill = false,
    skipStrokes = false,
    fillMaterial,
    strokeMaterial,
    fillMeshProps,
    strokeMeshProps,
    flipY = false,
    curveSegments = 12,
    strokeDivisions = 12,
    onLoad,
    onError,
    children,
    ...props
  },
  ref,
) {
  const scene = useScene(),
    [parts, setParts] = useState<readonly Part[]>([]),
    callbacks = useRef({ onLoad, onError });
  callbacks.current = { onLoad, onError };
  const source = String(src);
  useEffect(() => {
    const controller = new AbortController();
    const text = markup(src)
      ? Promise.resolve(src)
      : fetch(source, { signal: controller.signal }).then((response) => {
          if (!response.ok)
            throw fault(
              'failed',
              `Svg: ${source} answered ${response.status}; pass the URL of an SVG file or SVG markup`,
              'react-usage',
            );
          return response.text();
        });
    Promise.all([
      text,
      optionalPeer('@margoengine/loaders', () => import('@margoengine/loaders/svg')),
      optionalPeer('@margoengine/geometry', () => import('@margoengine/geometry')),
    ])
      .then(([content, loaders, geometry]) => {
        if (controller.signal.aborted || scene.engine.disposed) return;
        const svg = loaders.parseSVG(content),
          pending: { data: GeometryData; stroke: boolean; rgb: readonly number[]; opacity: number }[] = [];
        const add = (data: GeometryData, stroke: boolean, rgb: readonly number[], opacity: number) => {
          if (data.indices.length) pending.push({ data, stroke, rgb, opacity });
        };
        for (const path of svg.paths) {
          if (!skipFill && path.fill && path.fillOpacity > 0)
            add(geometry.shapeGeometry(path.toShapes({ flipY }), curveSegments), false, path.fill, path.fillOpacity);
          if (!skipStrokes && path.stroke && path.strokeOpacity > 0 && path.strokeWidth > 0)
            add(path.toStrokeGeometry({ flipY, divisions: strokeDivisions }), true, path.stroke, path.strokeOpacity);
        }
        const step = previewOnly(scene.engine) ? layerStep(extentOf(pending.map((part) => part.data)), pending.length) : 0;
        setParts(
          pending.map(({ data, stroke, rgb, opacity }, index) => {
            const made = geometry.toGeometry(data);
            geometrySources.set(made, data);
            return { stroke, geometry: made, color: hex(rgb), opacity, layer: index * step };
          }),
        );
        callbacks.current.onLoad?.(svg);
      })
      .catch((error) => {
        if (!controller.signal.aborted && !scene.engine.disposed) report(scene, error, callbacks.current.onError);
      });
    return () => controller.abort();
  }, [scene.engine, source, skipFill, skipStrokes, flipY, curveSegments, strokeDivisions]);
  const preview = previewOnly(scene.engine);
  return (
    <Mesh ref={ref} {...props}>
      {parts.map((part, index) => {
        const meshProps = part.stroke ? strokeMeshProps : fillMeshProps,
          options = part.stroke ? strokeMaterial : fillMaterial;
        if (preview) {
          const [x, y, z] = meshProps?.position ?? [0, 0, 0];
          return (
            <Mesh key={index} {...meshProps} position={[x, y, z + part.layer]}>
              <GeometryResource geometry={part.geometry} />
              <PbrMaterial
                color={options?.color ?? part.color}
                roughness={options?.roughness ?? 1}
                metalness={options?.metalness ?? 0}
              />
            </Mesh>
          );
        }
        return (
        <Mesh key={index} {...meshProps}>
          <GeometryResource geometry={part.geometry} />
          <TextureMaterial
            shading="basic"
            color={part.color}
            opacity={part.opacity}
            transparent
            depthWrite={false}
            doubleSided
            {...options}
            renderOrder={index}
            onError={onError}
          />
        </Mesh>
        );
      })}
      {children}
    </Mesh>
  );
});
