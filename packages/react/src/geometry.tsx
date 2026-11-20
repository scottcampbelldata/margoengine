import {
  forwardRef,
  useEffect,
  useRef,
  type ForwardRefExoticComponent,
  type PropsWithoutRef,
  type RefAttributes,
} from 'react';
import type { Geometry, Mesh as EngineMesh } from '@margoengine/core/extension';
import type * as GeometryModule from '@margoengine/geometry';
import type * as ExtrasModule from '@margoengine/geometry/extras';
import { Mesh, type PbrMaterialProps, type MeshProps, type MeshRef } from './components.js';
import { useScene, useMesh, live, setGeometry, report } from './internal.js';
import { MeshShadows } from './mesh-shadows.js';
import { optionalPeer } from './optional.js';
import { geometrySources } from './texture-geometry.js';
import { MappedPbrMaterial } from './texture-material.js';
import { PbrMaterial as PlainPbrMaterial } from './components.js';

export type { TextureSource } from './textured.js';

interface ErrorProps {
  onError?: (error: unknown) => void;
}

type GeometryApi = typeof GeometryModule;
/** The `@margoengine/geometry` builders the shape components wrap, by name. */
export interface ShapeFactories {
  boxGeometry: GeometryApi['boxGeometry'];
  sphereGeometry: GeometryApi['sphereGeometry'];
  planeGeometry: GeometryApi['planeGeometry'];
  cylinderGeometry: GeometryApi['cylinderGeometry'];
  coneGeometry: GeometryApi['coneGeometry'];
  capsuleGeometry: GeometryApi['capsuleGeometry'];
  circleGeometry: GeometryApi['circleGeometry'];
  ringGeometry: GeometryApi['ringGeometry'];
  torusGeometry: GeometryApi['torusGeometry'];
  torusKnotGeometry: GeometryApi['torusKnotGeometry'];
  tetrahedronGeometry: GeometryApi['tetrahedronGeometry'];
  octahedronGeometry: GeometryApi['octahedronGeometry'];
  icosahedronGeometry: GeometryApi['icosahedronGeometry'];
  dodecahedronGeometry: GeometryApi['dodecahedronGeometry'];
  polyhedronGeometry: GeometryApi['polyhedronGeometry'];
  latheGeometry: GeometryApi['latheGeometry'];
  tubeGeometry: GeometryApi['tubeGeometry'];
  shapeGeometry: GeometryApi['shapeGeometry'];
  extrudeGeometry: GeometryApi['extrudeGeometry'];
  roundedBoxGeometry: (typeof ExtrasModule)['roundedBoxGeometry'];
}
type ShapeKind = keyof ShapeFactories;
// Builders that live in `@margoengine/geometry/extras` rather than the package root.
const extras: ReadonlySet<ShapeKind> = new Set<ShapeKind>(['roundedBoxGeometry']);

// Objects other than plain objects, arrays and typed arrays (a Shape, a Curve) count by identity, so a builder runs
// again only when such an argument is replaced; numbers, arrays and plain objects count by value, so inline literals
// such as `args={[1, 2, 1]}` or lathe points written in JSX do not rebuild the geometry on every render.
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function argsKey(args: readonly unknown[]): string {
  return JSON.stringify(args, (_, value: unknown) => {
    if (value === undefined) return '\u0000undefined';
    if (typeof value === 'number' && !Number.isFinite(value)) return `\u0000${value}`;
    if (typeof value !== 'object' || value === null || Array.isArray(value) || ArrayBuffer.isView(value)) return value;
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) return value;
    let id = identities.get(value);
    if (id === undefined) identities.set(value, (id = ++nextIdentity));
    return `\u0000#${id}`;
  });
}
function BuiltGeometry({
  kind,
  args,
  onError,
}: {
  kind: ShapeKind;
  args: readonly unknown[];
  onError?: ErrorProps['onError'];
}) {
  const scene = useScene(),
    registry = useMesh(),
    error = useRef(onError),
    latest = useRef(args);
  error.current = onError;
  latest.current = args;
  const key = argsKey(args);
  useEffect(() => {
    let active = true,
      geometry: Geometry | undefined;
    const attach = (mesh: EngineMesh) => {
      if (geometry) setGeometry(registry, mesh, geometry);
    };
    const load = () => import('@margoengine/geometry'),
      loadExtras = () => import('@margoengine/geometry/extras');
    Promise.all([
      optionalPeer('@margoengine/geometry', load),
      extras.has(kind) ? optionalPeer('@margoengine/geometry', loadExtras) : undefined,
    ])
      .then(([api, extra]) => {
        if (!active || scene.engine.disposed) return;
        const create = ((extra ?? api) as unknown as Record<ShapeKind, (...args: readonly unknown[]) => unknown>)[kind];
        const data = create(...latest.current) as ReturnType<GeometryApi['boxGeometry']>;
        geometry = api.toGeometry(data);
        geometrySources.set(geometry, data);
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
/**
 * `args` of a shape: the builder's parameters in order. Optional (each has a default) except for `Polyhedron`, `Tube`,
 * `Shape` and `Extrude` and their geometry children, whose first parameter is required.
 */
export type ShapeArgs<K extends ShapeKind> =
  [] extends Parameters<ShapeFactories[K]>
    ? { args?: Parameters<ShapeFactories[K]> }
    : { args: Parameters<ShapeFactories[K]> };
/** Props of a geometry child such as `<CylinderGeometry>`; `args` are those of `@margoengine/geometry`. */
export type ShapeGeometryProps<K extends ShapeKind> = ErrorProps & ShapeArgs<K>;
function geometryComponent<K extends ShapeKind>(kind: K, name: string) {
  const component = (props: ShapeGeometryProps<K>) => (
    <BuiltGeometry kind={kind} args={(props.args ?? []) as readonly unknown[]} onError={props.onError} />
  );
  Object.defineProperty(component, 'name', { value: name });
  return component;
}
interface ShapeProps extends MeshProps, ErrorProps, PbrMaterialProps {
  castShadow?: boolean;
}
/** Props of a shape component such as `<Cylinder>`: the `Mesh` props, the material props and the builder's `args`. */
export type ShapeComponentProps<K extends ShapeKind> = ShapeProps & ShapeArgs<K>;
/** A one-element mesh: geometry, standard material and shadows. */
export type ShapeComponent<K extends ShapeKind> = ForwardRefExoticComponent<
  PropsWithoutRef<ShapeComponentProps<K>> & RefAttributes<MeshRef>
>;
function shapeComponent<K extends ShapeKind>(kind: K, name: string): ShapeComponent<K> {
  const component = forwardRef<MeshRef, ShapeComponentProps<K>>(function ShapeElement(
    {
      args,
      castShadow = false,
      onError,
      color,
      roughness,
      metalness,
      map,
      normalMap,
      roughnessMap,
      emissiveMap,
      metalRoughnessMap,
      emissive,
      emissiveIntensity,
      children,
      ...props
    },
    ref,
  ) {
    return (
      <Mesh {...props} ref={ref}>
        <BuiltGeometry kind={kind} args={(args ?? []) as readonly unknown[]} onError={onError} />
        <ShapeMaterial
          color={color}
          roughness={roughness}
          metalness={metalness}
          map={map}
          normalMap={normalMap}
          roughnessMap={roughnessMap}
          emissiveMap={emissiveMap}
          metalRoughnessMap={metalRoughnessMap}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
        />
        <MeshShadows castShadow={castShadow} onError={onError} />
        {children}
      </Mesh>
    );
  });
  component.displayName = name;
  return component;
}
function ShapeMaterial(props: PbrMaterialProps) {
  return props.map ||
    props.normalMap ||
    props.roughnessMap ||
    props.emissiveMap ||
    props.metalRoughnessMap ||
    props.emissive ? (
    <MappedPbrMaterial {...props} />
  ) : (
    <PlainPbrMaterial {...props} />
  );
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

/** A box: `args` [width, height, depth, widthSegments, heightSegments, depthSegments], default [1, 1, 1, 1, 1, 1]. */
export const Box: ShapeComponent<'boxGeometry'> = shapeComponent('boxGeometry', 'Box');
/** A UV sphere: `args` [radius, widthSegments, heightSegments, phiStart, phiLength, thetaStart, thetaLength]. */
export const Sphere: ShapeComponent<'sphereGeometry'> = shapeComponent('sphereGeometry', 'Sphere');
/** A plane in XY facing +Z: `args` [width, height, widthSegments, heightSegments]. */
export const Plane: ShapeComponent<'planeGeometry'> = shapeComponent('planeGeometry', 'Plane');
/** A cylinder along Y: `args` [radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength]. */
export const Cylinder: ShapeComponent<'cylinderGeometry'> = shapeComponent('cylinderGeometry', 'Cylinder');
/** A cone along Y: `args` [radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength]. */
export const Cone: ShapeComponent<'coneGeometry'> = shapeComponent('coneGeometry', 'Cone');
/** A capsule along Y: `args` [radius, height, capSegments, radialSegments, heightSegments]. */
export const Capsule: ShapeComponent<'capsuleGeometry'> = shapeComponent('capsuleGeometry', 'Capsule');
/** A disc in XY: `args` [radius, segments, thetaStart, thetaLength]. */
export const Circle: ShapeComponent<'circleGeometry'> = shapeComponent('circleGeometry', 'Circle');
/** A flat ring in XY: `args` [innerRadius, outerRadius, thetaSegments, phiSegments, thetaStart, thetaLength]. */
export const Ring: ShapeComponent<'ringGeometry'> = shapeComponent('ringGeometry', 'Ring');
/** A torus in XY: `args` [radius, tube, radialSegments, tubularSegments, arc]. */
export const Torus: ShapeComponent<'torusGeometry'> = shapeComponent('torusGeometry', 'Torus');
/** A (p, q) torus knot: `args` [radius, tube, tubularSegments, radialSegments, p, q]. */
export const TorusKnot: ShapeComponent<'torusKnotGeometry'> = shapeComponent('torusKnotGeometry', 'TorusKnot');
/** A tetrahedron: `args` [radius, detail, smooth]. */
export const Tetrahedron: ShapeComponent<'tetrahedronGeometry'> = shapeComponent('tetrahedronGeometry', 'Tetrahedron');
/** An octahedron: `args` [radius, detail, smooth]. */
export const Octahedron: ShapeComponent<'octahedronGeometry'> = shapeComponent('octahedronGeometry', 'Octahedron');
/** An icosahedron: `args` [radius, detail, smooth]. */
export const Icosahedron: ShapeComponent<'icosahedronGeometry'> = shapeComponent('icosahedronGeometry', 'Icosahedron');
/** A dodecahedron: `args` [radius, detail, smooth]. */
export const Dodecahedron: ShapeComponent<'dodecahedronGeometry'> = shapeComponent(
  'dodecahedronGeometry',
  'Dodecahedron',
);
/** Any polyhedron projected on a sphere: `args` [vertices, indices, radius, detail, smooth] (vertices and indices required). */
export const Polyhedron: ShapeComponent<'polyhedronGeometry'> = shapeComponent('polyhedronGeometry', 'Polyhedron');
/** A surface of revolution about Y: `args` [points ([x, y] pairs), segments, phiStart, phiLength]. */
export const Lathe: ShapeComponent<'latheGeometry'> = shapeComponent('latheGeometry', 'Lathe');
/** A tube along a curve: `args` [path, tubularSegments, radius, radialSegments, closed] (path required). */
export const Tube: ShapeComponent<'tubeGeometry'> = shapeComponent('tubeGeometry', 'Tube');
/** A flat filled 2D shape (with holes): `args` [shapes, curveSegments] (shapes required). */
export const Shape: ShapeComponent<'shapeGeometry'> = shapeComponent('shapeGeometry', 'Shape');
/** A 2D shape extruded along Z, with optional bevel: `args` [shapes, options] (shapes required). */
export const Extrude: ShapeComponent<'extrudeGeometry'> = shapeComponent('extrudeGeometry', 'Extrude');
/** A box with rounded edges and corners: `args` [width, height, depth, segments, radius], default [1, 1, 1, 2, 0.1]. */
export const RoundedBox: ShapeComponent<'roundedBoxGeometry'> = shapeComponent('roundedBoxGeometry', 'RoundedBox');

/** Sphere geometry for the enclosing `<Mesh>` (`<sphereGeometry>` after `extend({ SphereGeometry })`). */
export const SphereGeometry = geometryComponent('sphereGeometry', 'SphereGeometry');
/** Plane geometry for the enclosing `<Mesh>` (`<planeGeometry>` after `extend({ PlaneGeometry })`). */
export const PlaneGeometry = geometryComponent('planeGeometry', 'PlaneGeometry');
/** Cylinder geometry for the enclosing `<Mesh>`; `args` as `<Cylinder>`. */
export const CylinderGeometry = geometryComponent('cylinderGeometry', 'CylinderGeometry');
/** Cone geometry for the enclosing `<Mesh>`; `args` as `<Cone>`. */
export const ConeGeometry = geometryComponent('coneGeometry', 'ConeGeometry');
/** Capsule geometry for the enclosing `<Mesh>`; `args` as `<Capsule>`. */
export const CapsuleGeometry = geometryComponent('capsuleGeometry', 'CapsuleGeometry');
/** Circle geometry for the enclosing `<Mesh>`; `args` as `<Circle>`. */
export const CircleGeometry = geometryComponent('circleGeometry', 'CircleGeometry');
/** Ring geometry for the enclosing `<Mesh>`; `args` as `<Ring>`. */
export const RingGeometry = geometryComponent('ringGeometry', 'RingGeometry');
/** Torus geometry for the enclosing `<Mesh>`; `args` as `<Torus>`. */
export const TorusGeometry = geometryComponent('torusGeometry', 'TorusGeometry');
/** Torus knot geometry for the enclosing `<Mesh>`; `args` as `<TorusKnot>`. */
export const TorusKnotGeometry = geometryComponent('torusKnotGeometry', 'TorusKnotGeometry');
/** Tetrahedron geometry for the enclosing `<Mesh>`; `args` as `<Tetrahedron>`. */
export const TetrahedronGeometry = geometryComponent('tetrahedronGeometry', 'TetrahedronGeometry');
/** Octahedron geometry for the enclosing `<Mesh>`; `args` as `<Octahedron>`. */
export const OctahedronGeometry = geometryComponent('octahedronGeometry', 'OctahedronGeometry');
/** Icosahedron geometry for the enclosing `<Mesh>`; `args` as `<Icosahedron>`. */
export const IcosahedronGeometry = geometryComponent('icosahedronGeometry', 'IcosahedronGeometry');
/** Dodecahedron geometry for the enclosing `<Mesh>`; `args` as `<Dodecahedron>`. */
export const DodecahedronGeometry = geometryComponent('dodecahedronGeometry', 'DodecahedronGeometry');
/** Polyhedron geometry for the enclosing `<Mesh>`; `args` as `<Polyhedron>`. */
export const PolyhedronGeometry = geometryComponent('polyhedronGeometry', 'PolyhedronGeometry');
/** Lathe geometry for the enclosing `<Mesh>`; `args` as `<Lathe>`. */
export const LatheGeometry = geometryComponent('latheGeometry', 'LatheGeometry');
/** Tube geometry for the enclosing `<Mesh>`; `args` as `<Tube>`. */
export const TubeGeometry = geometryComponent('tubeGeometry', 'TubeGeometry');
/** Shape geometry for the enclosing `<Mesh>`; `args` as `<Shape>`. */
export const ShapeGeometry = geometryComponent('shapeGeometry', 'ShapeGeometry');
/** Extruded shape geometry for the enclosing `<Mesh>`; `args` as `<Extrude>`. */
export const ExtrudeGeometry = geometryComponent('extrudeGeometry', 'ExtrudeGeometry');
/** Rounded box geometry for the enclosing `<Mesh>`; `args` as `<RoundedBox>`. */
export const RoundedBoxGeometry = geometryComponent('roundedBoxGeometry', 'RoundedBoxGeometry');

export { Svg, type SvgProps, type SvgMaterialProps, type SvgMeshProps } from './svg.js';
export { Backdrop, type BackdropProps } from './backdrop.js';
