'use client';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type {
  Physics as PhysicsWorld,
  PhysicsOptions,
  PhysicsBody,
  BodyOptions,
  RapierModule,
  ColliderOptions,
  CollisionEvent,
  JointOptions,
  PhysicsJoint,
} from '@margoengine/physics';
import { Mesh, type MeshProps } from './components.js';
import { useScene, useCommit, useResourceEffect, type Scene, type Registry } from './internal.js';
import { descendants, worldPose, setWorldPose, type Triple, type Quaternion } from './scene-transform.js';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { optionalPeer } from './optional.js';
import { MargoError } from '@margoengine/math/errors';

interface PhysicsState {
  world: PhysicsWorld | null;
  sync: Set<() => void>;
}
const Context = createContext<PhysicsState | null>(null);
/** Props of the Physics component; every prop is optional unless noted. */
export interface PhysicsProps extends Omit<PhysicsOptions, 'rapier'> {
  children?: ReactNode;
  /** Supply initialized Rapier, or let the optional Rapier peer initialize lazily. */
  rapier?: RapierModule | PromiseLike<RapierModule>;
  onReady?: (physics: PhysicsWorld) => void;
  onError?: (error: unknown) => void;
}
let defaultRapier: Promise<RapierModule> | undefined;
function loadRapier(): Promise<RapierModule> {
  return (defaultRapier ??= (async () => {
    const module = await optionalPeer('@dimforge/rapier3d-compat', () => import('@dimforge/rapier3d-compat'));
    const api = module.default ?? module;
    await api.init();
    return api as unknown as RapierModule;
  })().catch((error) => {
    defaultRapier = undefined;
    throw error;
  }));
}

/** Own one optional Rapier world, stepped by the engine in always and demand modes. */
export function Physics({
  children,
  rapier,
  onReady,
  onError,
  gravity,
  paused = false,
  timeScale = 1,
  ...options
}: PhysicsProps) {
  const { engine } = useScene(),
    [world, setWorld] = useState<PhysicsWorld | null>(null),
    sync = useMemo(() => new Set<() => void>(), [engine]);
  const latest = useRef({ onReady, onError, gravity, paused, timeScale });
  latest.current = { onReady, onError, gravity, paused, timeScale };
  useResourceEffect(
    (lease) => {
      let current: PhysicsWorld | undefined;
      setWorld(null);
      void Promise.all([
        optionalPeer('@margoengine/physics', () => import('@margoengine/physics')),
        rapier ?? loadRapier(),
      ])
        .then(([api, R]) => {
          if (!lease.active || engine.disposed) return;
          current = new api.Physics(null, { ...options, ...latest.current, rapier: R });
          const instance = current;
          // The wrapper's update runs after Rapier synchronization, before the engine ticks transforms.
          engine.use({
            name: instance.name,
            setup: () => instance.setup(engine as unknown as EngineKernel),
            onPreUpdate(delta) {
              instance.update(delta);
              for (const update of sync) update();
            },
            dispose: () => instance.dispose(),
          });
          setWorld(instance);
          latest.current.onReady?.(instance);
        })
        .catch((error) => {
          current?.dispose();
          if (lease.active && !engine.disposed) {
            try {
              latest.current.onError?.(error);
            } finally {
              engine.onError(error);
            }
          }
        });
      return () => {
        current?.dispose();
      };
    },
    [
      engine,
      rapier,
      sync,
      options.name,
      options.fixedTimestep,
      options.maxSubsteps,
      options.interpolate,
      options.solverIterations,
      options.contactFilter,
    ],
  );
  useCommit(() => {
    if (!world || world.isDisposed) return;
    world.gravity = gravity ?? [0, -9.81, 0];
    world.paused = paused;
    world.timeScale = timeScale;
  }, [world, gravity?.[0], gravity?.[1], gravity?.[2], paused, timeScale]);
  const value = useMemo(() => ({ world, sync }), [world, sync]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Returns the Physics world of the nearest Physics component (null until it is ready); throws a MargoError (`state`) outside one. */
export function usePhysics(): PhysicsWorld | null {
  const state = useContext(Context);
  if (!state) throw new MargoError('state', 'usePhysics requires <Physics>; call it inside one.');
  return state.world;
}
/** Collider fitted to the mesh geometry: 'cuboid', 'hull' or 'trimesh'. */
export type AutomaticColliderMode = 'cuboid' | 'hull' | 'trimesh';
/** Colliders for a RigidBody: explicit options, a generation mode, or false for none. */
export type RigidBodyColliders = ColliderOptions | readonly ColliderOptions[] | AutomaticColliderMode | false;
/** Props of the RigidBody component; every prop is optional unless noted. */
export interface RigidBodyProps extends Omit<BodyOptions, 'position' | 'rotation' | 'colliders'>, MeshProps {
  /** Fit descendant geometry or loader bounds; false disables only automatic colliders. */
  colliders?: RigidBodyColliders;
  /** A collider of this body began touching another body. */
  onContactStart?: (event: CollisionEvent) => void;
  /** A collider of this body stopped touching another body. */
  onContactEnd?: (event: CollisionEvent) => void;
  /** A sensor collider began overlapping (this body's sensor or another body's sensor). */
  onIntersectionStart?: (event: CollisionEvent) => void;
  /** A sensor overlap ended. */
  onIntersectionEnd?: (event: CollisionEvent) => void;
  onReady?: (body: PhysicsBody) => void;
  onError?: (error: unknown) => void;
}
interface ColliderRequest {
  registry: Registry;
  options: () => ColliderOptions;
  onError: (error: unknown) => void;
  body?: PhysicsBody;
  mesh?: EngineMesh;
  collider?: ReturnType<PhysicsBody['addCollider']>;
  failed?: boolean;
}
interface BodyState {
  requests: Set<ColliderRequest>;
  refresh: () => void;
}
const BodyContext = createContext<BodyState | null>(null);

/** One body drives a transform group; children retain their local transforms. */
export function RigidBody({
  children,
  position,
  rotation,
  scale,
  onClick,
  onPointerOver,
  onPointerOut,
  ...options
}: RigidBodyProps) {
  const binding = useMemo<BodyState>(() => ({ requests: new Set(), refresh: () => {} }), []);
  return (
    <BodyContext.Provider value={binding}>
      <Mesh
        position={position}
        rotation={rotation}
        scale={scale}
        onClick={onClick}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
      >
        <BodyBinding {...options} transform={{ position, rotation, scale }} />
        {children}
      </Mesh>
    </BodyContext.Provider>
  );
}

const retainedGeometryError =
  'RigidBody: automatic trimesh collider generation requires retained CPU geometry. Provide an explicit <CuboidCollider> or configure loader geometry retention.';
const missingBoundsError =
  'RigidBody: automatic collider generation requires mesh bounds or retained CPU geometry. Provide an explicit <CuboidCollider>.';
/** Read only existing CPU arrays and cached loader bounds. Never read a GPU buffer back. */
function fitCollider(
  scene: Scene,
  root: EngineMesh,
  position: Triple,
  rotation: Quaternion,
  mode: AutomaticColliderMode,
): ColliderOptions | undefined {
  root.engine.store.tick(false);
  const inverse: Quaternion = [-rotation[0], -rotation[1], -rotation[2], rotation[3]],
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity],
    points: number[] = [],
    indices: number[] = [];
  const meshes = new Set(descendants(root.engine, root));
  const point = (world: Triple) => {
    const p = rotateByQuaternion([world[0] - position[0], world[1] - position[1], world[2] - position[2]], inverse);
    if (p.some((value) => !Number.isFinite(value)))
      throw new RangeError(
        'RigidBody: collider geometry contains non-finite positions; fix the mesh data or pass an explicit collider.',
      );
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], p[axis]);
      max[axis] = Math.max(max[axis], p[axis]);
    }
    if (mode !== 'cuboid') points.push(...p);
  };
  const boundCorners = (bounds: ArrayLike<number> | undefined, mesh?: EngineMesh): boolean => {
    if (!bounds || ![4, 6].includes(bounds.length) || Array.from(bounds).some((value) => !Number.isFinite(value)))
      return false;
    const min =
        bounds.length === 4
          ? [bounds[0] - bounds[3], bounds[1] - bounds[3], bounds[2] - bounds[3]]
          : [bounds[0], bounds[1], bounds[2]],
      max =
        bounds.length === 4
          ? [bounds[0] + bounds[3], bounds[1] + bounds[3], bounds[2] + bounds[3]]
          : [bounds[3], bounds[4], bounds[5]];
    if (min.some((value, axis) => value > max[axis])) return false;
    for (let corner = 0; corner < 8; corner++) {
      const [x, y, z] = [corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]],
        m = mesh?.matrix;
      point(
        m
          ? [
              m[0] * x + m[4] * y + m[8] * z + m[12],
              m[1] * x + m[5] * y + m[9] * z + m[13],
              m[2] * x + m[6] * y + m[10] * z + m[14],
            ]
          : [x, y, z],
      );
    }
    return true;
  };
  const geometry = (
    mesh: EngineMesh,
    vertices: ArrayLike<number> | undefined,
    sourceIndices: ArrayLike<number> | undefined,
    stride: number,
  ): boolean => {
    if (
      !vertices?.length ||
      vertices.length % stride ||
      (mode === 'trimesh' && (!sourceIndices?.length || sourceIndices.length % 3))
    )
      return false;
    const m = mesh.matrix,
      offset = points.length / 3;
    for (let at = 0; at < vertices.length; at += stride) {
      const x = vertices[at],
        y = vertices[at + 1],
        z = vertices[at + 2];
      point([
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      ]);
    }
    if (mode === 'trimesh')
      for (let at = 0; at < sourceIndices!.length; at++) indices.push(sourceIndices![at] + offset);
    return true;
  };
  for (const mesh of meshes)
    if (mesh.geometry && !geometry(mesh, mesh.geometry.vertices, mesh.geometry.indices, 6)) {
      if (mode === 'trimesh') throw new MargoError('state', retainedGeometryError);
      if (!boundCorners(mesh.geometry.bounds, mesh)) throw new MargoError('state', missingBoundsError);
    }
  for (const model of scene.resources.models)
    if (!model.disposed && meshes.has(model.root)) {
      let missing = !model.primitives.length;
      for (const primitive of model.primitives)
        if (!geometry(primitive.node, primitive.vertices, primitive.indices, 20)) missing = true;
      if (!missing) continue;
      if (mode === 'trimesh') throw new MargoError('state', retainedGeometryError);
      // Plugin-owned primitives may expose bounds without CPU attributes. Their bounds are world-space.
      let bounds: ArrayLike<number> | undefined;
      try {
        bounds = model.bounds;
      } catch {
        throw new MargoError('state', missingBoundsError);
      }
      if (!boundCorners(bounds)) throw new MargoError('state', missingBoundsError);
    }
  if (!Number.isFinite(min[0])) return;
  if (mode === 'trimesh') return { shape: 'trimesh', vertices: points, indices };
  if (mode === 'hull') return { shape: 'convexHull', points };
  return {
    shape: 'box',
    halfExtents: max.map((value, index) => Math.max((value - min[index]) / 2, 1e-6)) as unknown as Triple,
    offset: max.map((value, index) => (value + min[index]) / 2) as unknown as Triple,
  };
}

type ColliderBaseProps = Omit<
  Extract<ColliderOptions, { shape: 'box' }>,
  'shape' | 'halfExtents' | 'offset' | 'rotation'
> &
  Pick<MeshProps, 'position' | 'rotation' | 'scale'> & { onError?: (error: unknown) => void };
/** Props of the CuboidCollider component; every prop is optional unless noted. */
export interface CuboidColliderProps extends ColliderBaseProps {
  /** Half extents in local units. */ args: Triple;
}
/** Props of the BallCollider component; every prop is optional unless noted. */
export interface BallColliderProps extends ColliderBaseProps {
  args: readonly [radius: number];
}
/** Capsule along the local Y axis: `args` is `[halfHeight, radius]` of the straight section and caps. */
export interface CapsuleColliderProps extends ColliderBaseProps {
  args: readonly [halfHeight: number, radius: number];
}
/** Cylinder along the local Y axis: `args` is `[halfHeight, radius]`. */
export interface CylinderColliderProps extends ColliderBaseProps {
  args: readonly [halfHeight: number, radius: number];
}
/** Cone along the local Y axis: `args` is `[halfHeight, radius]`. */
export interface ConeColliderProps extends ColliderBaseProps {
  args: readonly [halfHeight: number, radius: number];
}
/** Props of `ConvexHullCollider`. */
export interface ConvexHullColliderProps extends ColliderBaseProps {
  /** Flat `x, y, z` points in local units; the collider is their convex hull. */
  args: readonly [points: ArrayLike<number>];
}
/** Props of `TrimeshCollider`. */
export interface TrimeshColliderProps extends ColliderBaseProps {
  /** Flat `x, y, z` vertices and triangle indices in local units. Use it on fixed bodies. */
  args: readonly [vertices: ArrayLike<number>, indices: ArrayLike<number>];
}
/** Props of `HeightfieldCollider`. */
export interface HeightfieldColliderProps extends ColliderBaseProps {
  /** `rows`, `columns`, `(rows + 1) * (columns + 1)` heights, and the `[x, y, z]` scale of the whole field. */
  args: readonly [rows: number, columns: number, heights: ArrayLike<number>, scale: Triple];
}
function ShapeCollider({
  shape,
  position,
  rotation,
  scale,
  onError,
  ...options
}: ColliderBaseProps & { shape: ColliderOptions }) {
  return (
    <Mesh position={position} rotation={rotation} scale={scale}>
      <ColliderBinding
        options={{ ...options, ...shape } as ColliderOptions}
        transform={{ position, rotation, scale }}
        onError={onError}
      />
    </Mesh>
  );
}
/** Explicit collider children work before a visual asset finishes loading. */
export function CuboidCollider({ args, ...props }: CuboidColliderProps) {
  return <ShapeCollider {...props} shape={{ shape: 'box', halfExtents: args }} />;
}
/** The ball collider component. */
export function BallCollider({ args, ...props }: BallColliderProps) {
  return <ShapeCollider {...props} shape={{ shape: 'sphere', radius: args[0] }} />;
}
/** Capsule collider along the local Y axis; `args` is `[halfHeight, radius]`. */
export function CapsuleCollider({ args, ...props }: CapsuleColliderProps) {
  return <ShapeCollider {...props} shape={{ shape: 'capsule', halfHeight: args[0], radius: args[1] }} />;
}
/** Cylinder collider along the local Y axis; `args` is `[halfHeight, radius]`. */
export function CylinderCollider({ args, ...props }: CylinderColliderProps) {
  return <ShapeCollider {...props} shape={{ shape: 'cylinder', halfHeight: args[0], radius: args[1] }} />;
}
/** Cone collider along the local Y axis; `args` is `[halfHeight, radius]`. */
export function ConeCollider({ args, ...props }: ConeColliderProps) {
  return <ShapeCollider {...props} shape={{ shape: 'cone', halfHeight: args[0], radius: args[1] }} />;
}
/** Convex hull of flat `x, y, z` points; `args` is `[points]`. */
export function ConvexHullCollider({ args, ...props }: ConvexHullColliderProps) {
  return <ShapeCollider {...props} shape={{ shape: 'convexHull', points: args[0] }} />;
}
/** Exact triangle-mesh collider; `args` is `[vertices, indices]`. Use it on fixed bodies. */
export function TrimeshCollider({ args, ...props }: TrimeshColliderProps) {
  return <ShapeCollider {...props} shape={{ shape: 'trimesh', vertices: args[0], indices: args[1] }} />;
}
/** Regular-grid terrain collider; `args` is `[rows, columns, heights, scale]`. */
export function HeightfieldCollider({ args, ...props }: HeightfieldColliderProps) {
  return (
    <ShapeCollider
      {...props}
      shape={{ shape: 'heightfield', rows: args[0], columns: args[1], heights: args[2], scale: args[3] }}
    />
  );
}
function scalePoints(points: ArrayLike<number>, scale: Triple): number[] {
  const out = new Array<number>(points.length);
  for (let at = 0; at < points.length; at++) out[at] = points[at] * scale[at % 3];
  return out;
}
/** Apply a collider child's world scale to its shape, the way a visual mesh would be scaled. */
function scaleCollider(source: ColliderOptions, scale: Triple): ColliderOptions {
  const abs = scale.map(Math.abs) as unknown as Triple,
    radial = Math.max(abs[0], abs[2]);
  switch (source.shape) {
    case 'box':
      return {
        ...source,
        halfExtents: source.halfExtents?.map((value, axis) => value * abs[axis]) as unknown as Triple,
      };
    case 'sphere':
      return { ...source, radius: source.radius === undefined ? undefined : source.radius * Math.max(...abs) };
    case 'capsule':
    case 'cylinder':
    case 'cone':
      return { ...source, halfHeight: source.halfHeight * abs[1], radius: source.radius * radial };
    case 'convexHull':
      return source.points ? { ...source, points: scalePoints(source.points, scale) } : source;
    case 'trimesh':
      return source.vertices ? { ...source, vertices: scalePoints(source.vertices, scale) } : source;
    case 'heightfield':
      return { ...source, scale: source.scale.map((value, axis) => value * abs[axis]) as unknown as Triple };
    default:
      return source;
  }
}
function releaseCollider(request: ColliderRequest): void {
  if (request.collider && request.body?.valid) request.body.removeCollider(request.collider);
  request.collider = undefined;
  request.body = undefined;
  request.mesh = undefined;
}
function ColliderBinding({
  options,
  transform,
  onError,
}: {
  options: ColliderOptions;
  transform: Pick<MeshProps, 'position' | 'rotation' | 'scale'>;
  onError?: (error: unknown) => void;
}) {
  const binding = useContext(BodyContext);
  if (!binding) throw new MargoError('state', 'Collider components require <RigidBody>; render them inside one.');
  const { engine, registry } = useScene(),
    latest = useRef({ options, onError });
  latest.current = { options, onError };
  useCommit(() => {
    if (!registry) return;
    const request: ColliderRequest = {
      registry,
      options: () => latest.current.options,
      onError: (error) => {
        try {
          latest.current.onError?.(error);
        } finally {
          engine.onError(error);
        }
      },
    };
    // Decide whether automatic fitting is needed after the whole layout commit:
    // replacing an explicit collider briefly leaves the request set empty.
    const refresh = () =>
      queueMicrotask(() => {
        if (!engine.disposed) binding.refresh();
      });
    registry.attachments.add(refresh);
    binding.requests.add(request);
    refresh();
    return () => {
      registry.attachments.delete(refresh);
      binding.requests.delete(request);
      releaseCollider(request);
      refresh();
    };
  }, [
    engine,
    registry,
    binding,
    JSON.stringify(options),
    transform.position?.[0],
    transform.position?.[1],
    transform.position?.[2],
    transform.rotation?.[0],
    transform.rotation?.[1],
    transform.rotation?.[2],
    transform.scale?.[0],
    transform.scale?.[1],
    transform.scale?.[2],
  ]);
  return null;
}

function BodyBinding({
  onReady,
  onError,
  onContactStart,
  onContactEnd,
  onIntersectionStart,
  onIntersectionEnd,
  transform,
  ...options
}: Omit<RigidBodyProps, keyof MeshProps> & { transform: Pick<MeshProps, 'position' | 'rotation' | 'scale'> }) {
  const state = useContext(Context);
  if (!state) throw new MargoError('state', 'RigidBody requires <Physics>; render it inside one.');
  const binding = useContext(BodyContext)!,
    scene = useScene(),
    { engine, registry } = scene,
    latest = useRef({ onReady, onError, onContactStart, onContactEnd, onIntersectionStart, onIntersectionEnd });
  latest.current = { onReady, onError, onContactStart, onContactEnd, onIntersectionStart, onIntersectionEnd };
  useResourceEffect(
    (lease) => {
      const world = state.world;
      if (!world || world.isDisposed || !registry) return;
      let body: PhysicsBody | undefined,
        unsubscribe: Array<() => void> = [],
        root: EngineMesh | undefined,
        automatic: ReturnType<PhysicsBody['addCollider']> | undefined,
        autoFailed = false;
      const mode =
        options.colliders === undefined
          ? 'cuboid'
          : typeof options.colliders === 'string'
            ? options.colliders
            : undefined;
      const fail = (error: unknown) => {
        if (lease.active && !engine.disposed) {
          try {
            latest.current.onError?.(error);
          } finally {
            engine.onError(error);
          }
        }
      };
      const refresh = () => {
        if (!lease.active || engine.disposed || !body?.valid || !root || engine.meshes.get(root.id) !== root) return;
        const pose = worldPose(root),
          inverse: Quaternion = [-pose.rotation[0], -pose.rotation[1], -pose.rotation[2], pose.rotation[3]];
        if (binding.requests.size && automatic) {
          body.removeCollider(automatic);
          automatic = undefined;
        }
        for (const request of binding.requests) {
          const mesh = request.registry.current;
          if (request.body !== body || request.mesh !== mesh) releaseCollider(request);
          if (!mesh || engine.meshes.get(mesh.id) !== mesh || request.collider || request.failed) continue;
          try {
            const child = worldPose(mesh),
              source = request.options(),
              offset = rotateByQuaternion(
                [
                  child.position[0] - pose.position[0],
                  child.position[1] - pose.position[1],
                  child.position[2] - pose.position[2],
                ],
                inverse,
              );
            const [px, py, pz, pw] = pose.rotation,
              [qx, qy, qz, qw] = child.rotation;
            const rotation: Quaternion = [
              pw * qx - px * qw - py * qz + pz * qy,
              pw * qy + px * qz - py * qw - pz * qx,
              pw * qz - px * qy + py * qx - pz * qw,
              pw * qw + px * qx + py * qy + pz * qz,
            ];
            const collider = scaleCollider(source, child.scale);
            request.collider = body.addCollider({ ...collider, offset, rotation });
            request.body = body;
            request.mesh = mesh;
          } catch (error) {
            request.failed = true;
            request.onError(error);
          }
        }
        if (mode && !binding.requests.size && !automatic && !autoFailed)
          try {
            const collider = fitCollider(scene, root, pose.position, pose.rotation, mode);
            if (collider) automatic = body.addCollider(collider);
          } catch (error) {
            autoFailed = true;
            fail(error);
          }
      };
      binding.refresh = refresh;
      const attach = (mesh: EngineMesh) => {
        if (engine.disposed || lease.closed || root === mesh) return;
        // Suspense reveal can recreate the Mesh while this resource lease retains its body.
        root = mesh;
        if (body) {
          queueMicrotask(() => {
            if (
              lease.active &&
              root === mesh &&
              body?.valid &&
              !engine.disposed &&
              engine.meshes.get(mesh.id) === mesh
            ) {
              setWorldPose(mesh, body.position, body.rotation);
              refresh();
            }
          });
          return;
        }
        if (!lease.active) return;
        try {
          const pose = worldPose(mesh),
            native =
              options.colliders === undefined || typeof options.colliders === 'string' || options.colliders === false
                ? []
                : options.colliders;
          body = world.addBody(null, {
            ...options,
            position: pose.position,
            rotation: pose.rotation,
            colliders: native,
          });
          const own = body;
          // Handlers are read at event time, so changing a callback never recreates the body.
          for (const [type, key] of [
            ['contactstart', 'onContactStart'],
            ['contactend', 'onContactEnd'],
            ['intersectionstart', 'onIntersectionStart'],
            ['intersectionend', 'onIntersectionEnd'],
          ] as const)
            unsubscribe.push(
              world.on(type, (event) => {
                if (event.bodyA === own || event.bodyB === own) latest.current[key]?.(event);
              }),
            );
          refresh();
          latest.current.onReady?.(body);
        } catch (error) {
          for (const off of unsubscribe) off();
          unsubscribe = [];
          body?.remove();
          body = undefined;
          fail(error);
        }
      };
      const update = () => {
        if (!body?.valid || !root || engine.meshes.get(root.id) !== root) return;
        const p = body.pose,
          alpha = world.interpolate ? world.alpha : 1;
        const position: Triple = [
          p[0] + (p[7] - p[0]) * alpha,
          p[1] + (p[8] - p[1]) * alpha,
          p[2] + (p[9] - p[2]) * alpha,
        ];
        // Shortest-path normalized quaternion interpolation matches rigid body orientation.
        const sign = p[3] * p[10] + p[4] * p[11] + p[5] * p[12] + p[6] * p[13] < 0 ? -1 : 1;
        const q = [0, 1, 2, 3].map((index) => p[3 + index] * (1 - alpha) + p[10 + index] * alpha * sign),
          length = Math.hypot(...q);
        const rotation = q.map((value) => value / length) as unknown as Quaternion;
        setWorldPose(root, position, rotation);
        refresh();
      };
      registry.attachments.add(attach);
      state.sync.add(update);
      if (registry.current) attach(registry.current);
      return () => {
        registry.attachments.delete(attach);
        state.sync.delete(update);
        if (binding.refresh === refresh) binding.refresh = () => {};
        for (const request of binding.requests) if (request.body === body) releaseCollider(request);
        for (const off of unsubscribe) off();
        if (!world.isDisposed) body?.remove();
      };
    },
    [
      engine,
      registry,
      state.world,
      state.sync,
      options.type,
      options.colliders,
      options.linearVelocity,
      options.angularVelocity,
      options.linearDamping,
      options.angularDamping,
      options.gravityScale,
      options.ccd,
      options.canSleep,
      options.sleeping,
      options.lockRotations,
      options.lockTranslations,
      options.enabledRotations,
      options.enabledTranslations,
      options.additionalMass,
      options.dominance,
      options.userData,
      transform.position?.[0],
      transform.position?.[1],
      transform.position?.[2],
      transform.rotation?.[0],
      transform.rotation?.[1],
      transform.rotation?.[2],
      transform.scale?.[0],
      transform.scale?.[1],
      transform.scale?.[2],
    ],
  );
  return null;
}
/**
 * Connect two bodies with a fixed, spherical, revolute or prismatic joint. Pass the bodies from `RigidBody`
 * `onReady` (kept in state or a ref callback); returns the joint once both exist, otherwise null. The joint is
 * removed on unmount and rebuilt when the bodies or options change.
 */
export function useJoint(
  bodyA: PhysicsBody | null | undefined,
  bodyB: PhysicsBody | null | undefined,
  options: JointOptions,
): PhysicsJoint | null {
  const world = usePhysics(),
    [joint, setJoint] = useState<PhysicsJoint | null>(null),
    key = JSON.stringify(options);
  useEffect(() => {
    if (!world || world.isDisposed || !bodyA?.valid || !bodyB?.valid) return;
    const created = world.addJoint(bodyA, bodyB, JSON.parse(key) as JointOptions);
    setJoint(created);
    return () => {
      setJoint(null);
      if (created.valid && !world.isDisposed) created.remove();
    };
  }, [world, bodyA, bodyB, key]);
  return joint;
}
function useStepEvent(type: 'beforestep' | 'afterstep', callback: (delta: number) => void): void {
  const world = usePhysics(),
    latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (!world || world.isDisposed) return;
    return world.on(type, (delta) => latest.current(delta));
  }, [world, type]);
}
/** Run `callback(delta)` before every fixed physics step; drive kinematic bodies and character controllers here. */
export function useBeforePhysicsStep(callback: (delta: number) => void): void {
  useStepEvent('beforestep', callback);
}
/** Run `callback(delta)` after every fixed physics step. */
export function useAfterPhysicsStep(callback: (delta: number) => void): void {
  useStepEvent('afterstep', callback);
}
export type {
  PhysicsBody,
  BodyOptions,
  PhysicsOptions,
  RapierModule,
  ColliderOptions,
  CollisionEvent,
  JointOptions,
  PhysicsJoint,
} from '@margoengine/physics';
