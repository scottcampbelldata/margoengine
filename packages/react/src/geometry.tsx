import { forwardRef, useEffect, useRef } from 'react';
import type { Geometry, Mesh as EngineMesh } from '@margoengine/core/extension';
import type * as GeometryModule from '@margoengine/geometry';
import { Mesh, PbrMaterial, type PbrMaterialProps, type MeshProps, type MeshRef } from './components.js';
import { useScene, useMesh, live, setGeometry, report } from './internal.js';
import { MeshShadows } from './mesh-shadows.js';
import { optionalPeer } from './optional.js';

interface ErrorProps {
  onError?: (error: unknown) => void;
}

type GeometryApi = typeof GeometryModule;
type ShapeKind = 'boxGeometry' | 'sphereGeometry' | 'planeGeometry';
function ShapeGeometry({
  kind,
  args,
  onError,
}: {
  kind: ShapeKind;
  args: readonly number[];
  onError?: ErrorProps['onError'];
}) {
  const scene = useScene(),
    registry = useMesh(),
    error = useRef(onError);
  error.current = onError;
  const key = JSON.stringify(args);
  useEffect(() => {
    let active = true,
      geometry: Geometry | undefined;
    const attach = (mesh: EngineMesh) => {
      if (geometry) setGeometry(registry, mesh, geometry);
    };
    optionalPeer('@margoengine/geometry', () => import('@margoengine/geometry'))
      .then((api) => {
        if (!active || scene.engine.disposed) return;
        const create = api[kind] as (...args: number[]) => ReturnType<GeometryApi[ShapeKind]>;
        geometry = api.toGeometry(create(...args));
        registry.attachments.add(attach);
        try {
          const mesh = live(registry);
          if (mesh) attach(mesh);
        } catch (error) {
          registry.attachments.delete(attach);
          throw error;
        }
      })
      .catch((cause) => {
        if (active && !scene.engine.disposed) report(scene, cause, error.current);
      });
    return () => {
      active = false;
      registry.attachments.delete(attach);
      const mesh = live(registry);
      if (mesh && registry.geometry === geometry) setGeometry(registry, mesh, null);
    };
  }, [scene.engine, registry, kind, key]);
  return null;
}
/** Props of the `SphereGeometry` and `PlaneGeometry` children; `args` are those of `@margoengine/geometry`. */
export interface ShapeGeometryProps<K extends ShapeKind> extends ErrorProps {
  args?: Parameters<GeometryApi[K]>;
}
/** Sphere geometry for the enclosing `<Mesh>` (`<sphereGeometry>` after `extend({ SphereGeometry })`). */
export function SphereGeometry({ args = [], onError }: ShapeGeometryProps<'sphereGeometry'>) {
  return <ShapeGeometry kind="sphereGeometry" args={args as number[]} onError={onError} />;
}
/** Plane geometry for the enclosing `<Mesh>` (`<planeGeometry>` after `extend({ PlaneGeometry })`). */
export function PlaneGeometry({ args = [], onError }: ShapeGeometryProps<'planeGeometry'>) {
  return <ShapeGeometry kind="planeGeometry" args={args as number[]} onError={onError} />;
}
interface ShapeProps extends MeshProps, ErrorProps, PbrMaterialProps {
  castShadow?: boolean;
}
/** Props of the Box component; every prop is optional unless noted. */
export interface BoxProps extends ShapeProps {
  args?: Parameters<GeometryApi['boxGeometry']>;
}
/** Props of the Sphere component; every prop is optional unless noted. */
export interface SphereProps extends ShapeProps {
  args?: Parameters<GeometryApi['sphereGeometry']>;
}
/** Props of the Plane component; every prop is optional unless noted. */
export interface PlaneProps extends ShapeProps {
  args?: Parameters<GeometryApi['planeGeometry']>;
}
/** The box component. */
export const Box = forwardRef<MeshRef, BoxProps>(function Box(
  { args = [], castShadow = false, onError, color, roughness, metalness, children, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <ShapeGeometry kind="boxGeometry" args={args as number[]} onError={onError} />
      <PbrMaterial color={color} roughness={roughness} metalness={metalness} />
      <MeshShadows castShadow={castShadow} onError={onError} />
      {children}
    </Mesh>
  );
});
/** The sphere component. */
export const Sphere = forwardRef<MeshRef, SphereProps>(function Sphere(
  { args = [], castShadow = false, onError, color, roughness, metalness, children, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <ShapeGeometry kind="sphereGeometry" args={args as number[]} onError={onError} />
      <PbrMaterial color={color} roughness={roughness} metalness={metalness} />
      <MeshShadows castShadow={castShadow} onError={onError} />
      {children}
    </Mesh>
  );
});
/** The plane component. */
export const Plane = forwardRef<MeshRef, PlaneProps>(function Plane(
  { args = [], castShadow = false, onError, color, roughness, metalness, children, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <ShapeGeometry kind="planeGeometry" args={args as number[]} onError={onError} />
      <PbrMaterial color={color} roughness={roughness} metalness={metalness} />
      <MeshShadows castShadow={castShadow} onError={onError} />
      {children}
    </Mesh>
  );
});
