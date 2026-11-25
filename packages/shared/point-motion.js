const STILL = Object.freeze([0, 0, 0]);

/** Normalizes and validates point-mass settings before any state is written. */
export function pointMotion(options) {
  if (!options || typeof options !== 'object')
    throw new TypeError('Locomotion settings must be an object; pass mass and optional drag or turning limits');
  const {
    mass = 1,
    dragFactor = 0,
    fluidVelocity = STILL,
    maxLateralAcceleration = Infinity,
    minimumTurnRadius = 0,
  } = options;
  if (!(mass > 0 && Number.isFinite(mass)))
    throw new RangeError('Locomotion mass must be finite and positive; pass kilograms');
  if (!(dragFactor >= 0 && Number.isFinite(dragFactor) && Number.isFinite(dragFactor / mass)))
    throw new RangeError(
      'Locomotion drag factor must be finite and nonnegative; pass half the density times drag coefficient and area',
    );
  if (!fluidVelocity || fluidVelocity.length !== 3 || !Array.from(fluidVelocity).every(Number.isFinite))
    throw new RangeError('Locomotion fluid velocity must be finite; pass [x, y, z] in metres per second');
  if (
    !(typeof maxLateralAcceleration === 'number' && maxLateralAcceleration >= 0) ||
    !(minimumTurnRadius >= 0 && Number.isFinite(minimumTurnRadius))
  )
    throw new RangeError(
      'Locomotion turning limits must be nonnegative; pass lateral acceleration and a finite radius in metres',
    );
  return { mass, dragRate: dragFactor / mass, fluidVelocity, maxLateralAcceleration, minimumTurnRadius };
}

// A scaled Euclidean norm avoids overflow in the products for finite inputs and uses the correctly rounded sqrt.
function norm(x, y, z) {
  const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  return scale > 0
    ? scale * Math.sqrt((x / scale) * (x / scale) + (y / scale) * (y / scale) + (z / scale) * (z / scale))
    : 0;
}

/** Integrates capped propulsive acceleration and then the exact quadratic drag flow over the step. */
export function pointVelocity(velocity, force, dt, settings, maxSpeed, out) {
  const { mass, dragRate, fluidVelocity, maxLateralAcceleration, minimumTurnRadius } = settings;
  const [flowX, flowY, flowZ] = fluidVelocity;
  let vx = velocity[0] - flowX,
    vy = velocity[1] - flowY,
    vz = velocity[2] - flowZ;
  let ax = force[0] / mass,
    ay = force[1] / mass,
    az = force[2] / mass;
  const speed = norm(vx, vy, vz);
  if (speed > 0 && (maxLateralAcceleration < Infinity || minimumTurnRadius > 0)) {
    const dx = vx / speed,
      dy = vy / speed,
      dz = vz / speed;
    const along = ax * dx + ay * dy + az * dz;
    const lx = ax - along * dx,
      ly = ay - along * dy,
      lz = az - along * dz;
    const lateral = norm(lx, ly, lz);
    const bound = Math.min(
      maxLateralAcceleration,
      minimumTurnRadius > 0 ? (speed / minimumTurnRadius) * speed : Infinity,
    );
    if (lateral > bound) {
      const ratio = bound / lateral;
      ax = along * dx + lx * ratio;
      ay = along * dy + ly * ratio;
      az = along * dz + lz * ratio;
    }
  }
  vx += ax * dt;
  vy += ay * dt;
  vz += az * dt;
  const accelerated = norm(vx, vy, vz);
  const scale = accelerated > 0 ? Math.min(1 / (1 + dragRate * accelerated * dt), maxSpeed / accelerated) : 1;
  const x = flowX + vx * scale,
    y = flowY + vy * scale,
    z = flowZ + vz * scale;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
    throw new RangeError(
      'Locomotion velocity is out of range; use finite simulation units and a smaller force or timestep',
    );
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}
