import type { Mesh } from '@margoengine/core';
import type { Wind } from '@margoengine/math/fields';
import type { Vehicle, WindForce, Physics, PhysicsBody, VehicleOptions } from '@margoengine/physics';
import { numberIn, type DrivePoint } from './drive-path.js';

/** Body dimensions from an authored or procedural asset, a measured mass and the actual wheel mounts. */
export interface RoadVehicleOptions extends VehicleOptions {
  /** Vehicle dimensions in the chassis's local X/Y/Z order, metres. */
  readonly size: DrivePoint;
  /** Chassis mass in kilograms. */
  readonly mass: number;
  /** Body origin, metres. Default origin. */
  readonly position?: DrivePoint;
  /** Offset of the chassis collider centre from the body origin, metres. Default zero. */
  readonly colliderOffset?: DrivePoint;
  /** Optional air field. Add an AirSolver when stepping the attachment on a PhysicsWorld clock. */
  readonly wind?: Wind;
}

export interface RoadVehicleAssembly {
  readonly body: PhysicsBody;
  readonly vehicle: Vehicle;
  readonly wind?: WindForce;
}

/** Give a procedural vehicle a physical chassis, wheels and optional weather wind. Physics owns the result. */
export async function addRoadVehicle(
  physics: Physics,
  mesh: Mesh | null,
  options: RoadVehicleOptions,
  signal?: AbortSignal,
): Promise<RoadVehicleAssembly> {
  signal?.throwIfAborted();
  const { Vehicle, WindForce } = await import('@margoengine/physics');
  signal?.throwIfAborted();
  const { size, mass, position, colliderOffset, wind, ...vehicleOptions } = options;
  const halfExtents: [number, number, number] = [
    0.5 * numberIn(size[0], 'chassis size X', Number.MIN_VALUE),
    0.5 * numberIn(size[1], 'chassis size Y', Number.MIN_VALUE),
    0.5 * numberIn(size[2], 'chassis size Z', Number.MIN_VALUE),
  ];
  const body = physics.addBody(mesh, {
    position,
    colliders: {
      shape: 'box',
      halfExtents,
      offset: colliderOffset,
      mass: numberIn(mass, 'chassis mass', Number.MIN_VALUE),
    },
  });
  try {
    const vehicle = new Vehicle(physics, body, vehicleOptions);
    const drag = wind
      ? new WindForce(physics, { velocity: wind, filter: { predicate: (candidate) => candidate === body } })
      : undefined;
    return { body, vehicle, wind: drag };
  } catch (error) {
    physics.removeBody(body);
    throw error;
  }
}
