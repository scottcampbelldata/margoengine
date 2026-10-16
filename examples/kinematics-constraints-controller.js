import {
  AvoidanceSolver,
  CapsuleVolume,
  SphereVolume,
  SolveStatus,
} from '../packages/kinematics-constraints/dist/index.js';

/** Demo controller. Only Success commits a complete pose; no continuous sweep is certified. */
export function createConstraintDemo() {
  const root = new Float32Array([0.48, 1.25, 0]);
  const rawTarget = new Float32Array([0.9, 0.7, 0.14]);
  const initialTarget = new Float32Array(rawTarget);
  const currentHand = new Float32Array(rawTarget),
    currentElbow = new Float32Array(3);
  const projectedTarget = new Float32Array(rawTarget),
    chaseTarget = new Float32Array(3);
  const paceTarget = new Float32Array(3);
  const detourTarget = new Float32Array(3);
  const contactTarget = new Float32Array(3),
    contactElbow = new Float32Array(3);
  const contactGradient = new Float64Array(3);
  const commandTarget = new Float32Array(3),
    lastSolveTarget = new Float32Array(3),
    lastSolveRoot = new Float32Array(3);
  const upperLength = 0.55,
    lowerLength = 0.52,
    elbowRadius = 0.065,
    forearmRadius = 0.055;
  const torso = new CapsuleVolume({
    start: [0, 0.45, 0],
    end: [0, 1.2, 0],
    radius: 0.32,
  });
  const obstacle = new SphereVolume({
    center: [-0.33, 0.9, 0.47],
    radius: 0.14,
  });
  const rail = new CapsuleVolume({
    start: [0.12, 0.42, 0.52],
    end: [0.79, 0.42, 0.52],
    radius: 0.045,
  });
  const volumes = [torso],
    mixedVolumes = [torso, obstacle, rail];
  const solveOptions = {
    swivelSpeedLimit: Math.PI,
    reachMargin: 0.001,
    foldMargin: 0.015,
    searchBudget: 128,
  };
  const bendAxis = new Float64Array(3),
    bendReference = new Float64Array(3),
    bendScratch = new Float64Array(3);
  let hasBendFrame = false,
    avoidance,
    projection,
    result,
    targetResult;
  let scene = 'torso',
    mode = 'chain',
    minClearance = 0.008,
    damping = 0.12;
  let acceptedClearance = Infinity,
    yaw = 0,
    yawAssist = false,
    chased = false,
    rawStatus = 0,
    dt = 1 / 60;
  let paced = false,
    paused = false;
  let outwardDetour = false;
  let acceptedPole = 0,
    iterations = 0,
    solveCalls = 0,
    handStep = 0;
  let clock = 'live',
    angleStep = 0,
    targetClearance = Infinity,
    clampActive = false;
  const length3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
  function transportBendFrame(ax, ay, az, out) {
    let bx, by, bz;
    if (hasBendFrame) {
      bx = bendReference[0];
      by = bendReference[1];
      bz = bendReference[2];
      const vx = bendAxis[1] * az - bendAxis[2] * ay;
      const vy = bendAxis[2] * ax - bendAxis[0] * az;
      const vz = bendAxis[0] * ay - bendAxis[1] * ax;
      const cosine = Math.max(-1, Math.min(1, bendAxis[0] * ax + bendAxis[1] * ay + bendAxis[2] * az));
      if (cosine > -1 + 1e-8) {
        const cx = vy * bz - vz * by,
          cy = vz * bx - vx * bz,
          cz = vx * by - vy * bx;
        const inverse = 1 / (1 + cosine);
        bx += cx + (vy * cz - vz * cy) * inverse;
        by += cy + (vz * cx - vx * cz) * inverse;
        bz += cz + (vx * cy - vy * cx) * inverse;
      }
    } else {
      bx = 0;
      by = Math.abs(ay) < 0.9 ? -1 : 0;
      bz = Math.abs(ay) < 0.9 ? 0 : 1;
    }
    const along = bx * ax + by * ay + bz * az;
    bx -= along * ax;
    by -= along * ay;
    bz -= along * az;
    const length = length3(bx, by, bz);
    out[0] = bx / length;
    out[1] = by / length;
    out[2] = bz / length;
  }
  function commitBendFrame() {
    const ax = currentHand[0] - root[0],
      ay = currentHand[1] - root[1],
      az = currentHand[2] - root[2];
    const length = length3(ax, ay, az);
    transportBendFrame(ax / length, ay / length, az / length, bendScratch);
    bendReference.set(bendScratch);
    bendAxis[0] = ax / length;
    bendAxis[1] = ay / length;
    bendAxis[2] = az / length;
    hasBendFrame = true;
  }
  function evaluateElbowIK(shoulder, target, poleAngle, out) {
    let ax = target[0] - shoulder[0],
      ay = target[1] - shoulder[1],
      az = target[2] - shoulder[2];
    const distance = length3(ax, ay, az);
    if (!(distance > 0)) throw new RangeError('Two-bone target has zero reach');
    ax /= distance;
    ay /= distance;
    az /= distance;
    transportBendFrame(ax, ay, az, bendScratch);
    const bx = bendScratch[0],
      by = bendScratch[1],
      bz = bendScratch[2];
    const cx = ay * bz - az * by,
      cy = az * bx - ax * bz,
      cz = ax * by - ay * bx;
    const along = (upperLength * upperLength + distance * distance - lowerLength * lowerLength) / (2 * distance);
    const heightSquared = upperLength * upperLength - along * along;
    if (heightSquared < -1e-8) throw new RangeError('Two-bone target exceeds reach');
    const height = Math.sqrt(Math.max(0, heightSquared)),
      cosine = Math.cos(poleAngle),
      sine = Math.sin(poleAngle);
    out[0] = shoulder[0] + ax * along + height * (bx * cosine + cx * sine);
    out[1] = shoulder[1] + ay * along + height * (by * cosine + cy * sine);
    out[2] = shoulder[2] + az * along + height * (bz * cosine + cz * sine);
  }
  function measurePoseAt(hand, elbow) {
    let gap = Infinity;
    const active = scene === 'mixed' ? mixedVolumes : volumes;
    for (let i = 0; i < active.length; i++) {
      gap = Math.min(
        gap,
        active[i].segmentClearance(root, elbow, elbowRadius),
        active[i].segmentClearance(elbow, hand, forearmRadius),
      );
    }
    return gap;
  }
  function measurePose() {
    return measurePoseAt(currentHand, currentElbow);
  }
  function measureTarget(point) {
    let gap = Infinity;
    const active = scene === 'mixed' ? mixedVolumes : volumes;
    for (let i = 0; i < active.length; i++)
      gap = Math.min(gap, active[i].segmentClearance(point, point, forearmRadius));
    return gap;
  }
  function solve(target) {
    lastSolveTarget.set(target);
    lastSolveRoot.set(root);
    const candidate = avoidance.solve(
      root,
      currentHand,
      target,
      upperLength,
      lowerLength,
      elbowRadius,
      forearmRadius,
      dt,
      evaluateElbowIK,
      solveOptions,
    );
    iterations += candidate.iterations;
    solveCalls++;
    return candidate;
  }
  function accept() {
    currentHand.set(result.target);
    currentElbow.set(result.elbow);
    acceptedPole = result.poleAngle;
    commitBendFrame();
    acceptedClearance = measurePose();
  }
  function reset() {
    rawTarget.set(initialTarget);
    currentHand.set(initialTarget);
    root[0] = 0.48;
    root[1] = 1.25;
    root[2] = 0;
    hasBendFrame = false;
    yaw = 0;
    chased = false;
    outwardDetour = false;
    paced = false;
    handStep = 0;
    clampActive = false;
    iterations = 0;
    solveCalls = 0;
    avoidance.reset();
    projection.reset();
    dt = 1 / 60;
    commandTarget.set(initialTarget);
    result = solve(initialTarget);
    rawStatus = result.status;
    if (!result.resolved) throw new Error('Demo starting pose failed validation');
    accept();
    angleStep = 0;
    projectedTarget.set(currentHand);
    targetClearance = measureTarget(projectedTarget);
    projection.resolveTarget(initialTarget, dt);
    targetResult = projection.targetResult;
  }
  function configure(settings) {
    const nextScene = settings.scene ?? scene,
      nextGap = settings.minClearance ?? minClearance,
      nextDamping = settings.damping ?? damping;
    if (nextScene !== 'torso' && nextScene !== 'mixed') throw new RangeError('Unknown scene');
    if (!Number.isFinite(nextGap) || nextGap < 0 || nextGap > 0.03) throw new RangeError('Gap must be 0–30 mm');
    if (!Number.isFinite(nextDamping) || nextDamping < 0 || nextDamping > 0.3)
      throw new RangeError('Damping must be 0–0.3 seconds');
    scene = nextScene;
    minClearance = nextGap;
    damping = nextDamping;
    const active = scene === 'mixed' ? mixedVolumes : volumes;
    const options = {
      minClearance,
      complianceMargin: 0.003,
      targetRadius: forearmRadius,
      damping,
      maxIterations: 24,
    };
    avoidance = new AvoidanceSolver(active, options);
    projection = new AvoidanceSolver(active, options);
    reset();
  }
  function step(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Frame delta must be finite and nonnegative');
    if (seconds === 0) {
      outwardDetour = false;
      return result;
    }
    dt = clock === 'fixed60' ? 1 / 60 : clock === 'fixed120' ? 1 / 120 : Math.min(seconds, 1 / 20);
    chased = false;
    outwardDetour = false;
    paced = false;
    angleStep = 0;
    handStep = 0;
    iterations = 0;
    solveCalls = 0;
    if (paused) return result;
    clampActive = measureTarget(rawTarget) < minClearance + avoidance.complianceMargin;
    if (mode === 'target') {
      const px = projectedTarget[0],
        py = projectedTarget[1],
        pz = projectedTarget[2];
      commandTarget.set(rawTarget);
      lastSolveTarget.set(rawTarget);
      lastSolveRoot.set(root);
      const point = projection.resolveTarget(rawTarget, dt);
      targetResult = projection.targetResult;
      iterations = targetResult.iterations;
      if (targetResult.resolved) {
        projectedTarget.set(point);
        targetClearance = measureTarget(projectedTarget);
        handStep = length3(projectedTarget[0] - px, projectedTarget[1] - py, projectedTarget[2] - pz);
      }
      return result;
    }
    const oldX = root[0],
      oldZ = root[2],
      previousAngle = acceptedPole;
    const hx = currentHand[0],
      hy = currentHand[1],
      hz = currentHand[2];
    const desiredYaw = yawAssist ? (Math.max(0, Math.min(1, (0.2 - rawTarget[0]) / 0.6)) * 25 * Math.PI) / 180 : 0;
    const nextYaw = yaw + (desiredYaw - yaw) * (1 - Math.exp(-dt / 0.18));
    root[0] = 0.48 * Math.cos(nextYaw);
    root[2] = 0.48 * Math.sin(nextYaw);
    const requestDistance = length3(
      rawTarget[0] - currentHand[0],
      rawTarget[1] - currentHand[1],
      rawTarget[2] - currentHand[2],
    );
    const requestedReach = length3(rawTarget[0] - root[0], rawTarget[1] - root[1], rawTarget[2] - root[2]);
    const rawAllowed =
      requestedReach >= Math.abs(upperLength - lowerLength) + solveOptions.foldMargin &&
      requestedReach <= upperLength + lowerLength - solveOptions.reachMargin;
    const attenuation = damping > 0 ? 1 - Math.exp(-dt / damping) : 1;
    const requestLimit = attenuation > 0 ? (0.75 * dt) / attenuation : Infinity;
    let request = rawTarget;
    if (rawAllowed && requestDistance > requestLimit) {
      const factor = requestLimit / requestDistance;
      for (let i = 0; i < 3; i++) paceTarget[i] = currentHand[i] + (rawTarget[i] - currentHand[i]) * factor;
      request = paceTarget;
      paced = true;
    }
    commandTarget.set(request);
    result = solve(request);
    detourTarget.set(result.target);
    rawStatus = result.status;
    // Bounded local recovery is a controller policy. Failed calls retain solver
    // history; each retry uses the same dt and must satisfy every package guard.
    // Singular raw requests deliberately remain diagnostic, never silently chased.
    const rawDistance = length3(rawTarget[0] - root[0], rawTarget[1] - root[1], rawTarget[2] - root[2]);
    const rawInReach =
      rawDistance >= Math.abs(upperLength - lowerLength) + solveOptions.foldMargin &&
      rawDistance <= upperLength + lowerLength - solveOptions.reachMargin;
    if (!result.resolved && rawInReach && result.status !== SolveStatus.SingularDeadZone) {
      for (let fraction = 0.5; fraction >= 0.0625; fraction *= 0.5) {
        for (let i = 0; i < 3; i++) chaseTarget[i] = currentHand[i] + (request[i] - currentHand[i]) * fraction;
        result = solve(chaseTarget);
        if (result.resolved) {
          chased = true;
          break;
        }
      }
      // Front-view demo policy: a straight local chord can cut through the
      // forearm's contact envelope even when its far endpoint is reachable.
      // Try a contact-tangent waypoint with a small clearance reserve before
      // holding. Account for damping to bound the prospective hand step.
      // Every waypoint goes through the unchanged full-chain solve and pole
      // window; failures never advance the accepted pose or solver history.
      if (
        !result.resolved &&
        rawStatus === SolveStatus.ObstacleOccluded &&
        currentHand[2] >= root[2] &&
        request[2] >= root[2]
      ) {
        // Leave a small reserve for Float32 output and the target contact band.
        const limit = 0.75 * dt * 0.99;
        const blend = damping > 0 ? -Math.expm1(-dt / damping) : 1;
        const angle = result.poleAngle;
        // Estimate the local full-link contact gradient around the rejected
        // bounded pose. This includes elbow motion induced by the two-bone
        // geometry, rather than assuming the hand's point normal is enough.
        contactTarget.set(result.target);
        const contactReach = length3(
          contactTarget[0] - root[0],
          contactTarget[1] - root[1],
          contactTarget[2] - root[2],
        );
        const difference = Math.min(
          0.0001,
          Math.max(
            0,
            Math.min(contactReach - Math.abs(upperLength - lowerLength), upperLength + lowerLength - contactReach) *
              0.25,
          ),
        );
        for (let axis = 0; axis < 3; axis++) {
          const center = contactTarget[axis];
          contactTarget[axis] = center + difference;
          const high = contactTarget[axis];
          evaluateElbowIK(root, contactTarget, angle, contactElbow);
          const highGap = measurePoseAt(contactTarget, contactElbow);
          contactTarget[axis] = center - difference;
          const low = contactTarget[axis];
          evaluateElbowIK(root, contactTarget, angle, contactElbow);
          const lowGap = measurePoseAt(contactTarget, contactElbow);
          contactGradient[axis] = high !== low ? (highGap - lowGap) / (high - low) : 0;
          contactTarget[axis] = center;
        }
        const gx = contactGradient[0],
          gy = contactGradient[1],
          gz = contactGradient[2];
        const gradientSquared = gx * gx + gy * gy + gz * gz;
        const dx = detourTarget[0] - currentHand[0],
          dy = detourTarget[1] - currentHand[1],
          dz = detourTarget[2] - currentHand[2];
        const inward = gradientSquared > 1e-12 ? Math.min(0, (dx * gx + dy * gy + dz * gz) / gradientSquared) : 0;
        for (let reserve = 0.01; reserve <= 0.16; reserve *= 2) {
          if (!(limit > 0) || !(blend > 0)) break;
          const bias = gradientSquared > 1e-12 ? (limit * reserve) / Math.sqrt(gradientSquared) : 0;
          const x = dx - gx * inward + gx * bias,
            y = dy - gy * inward + gy * bias;
          const z = dz - gz * inward + gz * bias;
          const length = length3(x, y, z);
          const scale = length > limit ? limit / length : 1;
          const xStep = x * scale,
            yStep = y * scale,
            zStep = z * scale;
          // Do not replace a blocked gesture with unconstrained outward drift.
          // A waypoint must also reduce distance to the user's actual target.
          const progress =
            2 *
            (xStep * (rawTarget[0] - currentHand[0]) +
              yStep * (rawTarget[1] - currentHand[1]) +
              zStep * (rawTarget[2] - currentHand[2]));
          if (progress <= xStep * xStep + yStep * yStep + zStep * zStep) continue;
          detourTarget[0] = currentHand[0] + xStep / blend;
          detourTarget[1] = currentHand[1] + yStep / blend;
          detourTarget[2] = currentHand[2] + zStep / blend;
          // Inverting damping can put the generated input outside reach even
          // though its prospective hand step is inside. Condition this local
          // waypoint before solve; actual raw singular requests still hold.
          const minimum = Math.abs(upperLength - lowerLength) + solveOptions.foldMargin;
          const maximum = upperLength + lowerLength - solveOptions.reachMargin;
          const inset = Math.min(0.000002, (maximum - minimum) * 0.25);
          let rx = detourTarget[0] - root[0],
            ry = detourTarget[1] - root[1],
            rz = detourTarget[2] - root[2];
          let reach = length3(rx, ry, rz);
          if (reach < minimum + inset || reach > maximum - inset) {
            if (!(reach > 0)) {
              rx = currentHand[0] - root[0];
              ry = currentHand[1] - root[1];
              rz = currentHand[2] - root[2];
              reach = length3(rx, ry, rz);
            }
            const bounded = Math.max(minimum + inset, Math.min(maximum - inset, reach));
            detourTarget[0] = root[0] + (rx / reach) * bounded;
            detourTarget[1] = root[1] + (ry / reach) * bounded;
            detourTarget[2] = root[2] + (rz / reach) * bounded;
          }
          result = solve(detourTarget);
          if (result.resolved) {
            chased = outwardDetour = true;
            break;
          }
        }
      }
    }
    if (result.resolved) {
      yaw = nextYaw;
      angleStep = Math.abs(result.poleAngle - previousAngle);
      accept();
      handStep = length3(currentHand[0] - hx, currentHand[1] - hy, currentHand[2] - hz);
    } else {
      root[0] = oldX;
      root[2] = oldZ;
    }
    return result;
  }
  function setTarget(x, y, z = 0) {
    rawTarget[0] = x;
    rawTarget[1] = y;
    rawTarget[2] = z;
  }
  function setInteractiveTarget(x, y) {
    const maximum = upperLength + lowerLength - solveOptions.reachMargin - 2e-6;
    const shell = torso.radius + forearmRadius + minClearance + avoidance.complianceMargin * 0.5;
    let z = 0;
    for (let i = 0; i < 12; i++) {
      const dyTorso = y - Math.max(torso.start[1], Math.min(torso.end[1], y));
      z = Math.sqrt(Math.max(0, shell * shell - dyTorso * dyTorso));
      const dx = x - root[0],
        dy = y - root[1],
        dz = z - root[2],
        distance = length3(dx, dy, dz);
      if (distance <= maximum) break;
      const scale = maximum / distance;
      x = root[0] + dx * scale;
      y = root[1] + dy * scale;
      z = root[2] + dz * scale;
    }
    setTarget(x, y, z);
  }
  configure({});
  return {
    root,
    commandTarget,
    lastSolveTarget,
    lastSolveRoot,
    rawTarget,
    currentHand,
    currentElbow,
    projectedTarget,
    initialTarget,
    torso,
    obstacle,
    rail,
    solveOptions,
    upperLength,
    lowerLength,
    elbowRadius,
    forearmRadius,
    step,
    reset,
    configure,
    setTarget,
    setInteractiveTarget,
    get avoidance() {
      return avoidance;
    },
    get result() {
      return result;
    },
    get targetResult() {
      return targetResult;
    },
    get clearance() {
      return acceptedClearance;
    },
    get volumes() {
      return scene === 'mixed' ? mixedVolumes : volumes;
    },
    get scene() {
      return scene;
    },
    get mode() {
      return mode;
    },
    get dt() {
      return dt;
    },
    get chased() {
      return chased;
    },
    get outwardDetour() {
      return outwardDetour;
    },
    get rawStatus() {
      return rawStatus;
    },
    get yaw() {
      return yaw;
    },
    get yawAssist() {
      return yawAssist;
    },
    get dragShell() {
      return torso.radius + forearmRadius + minClearance + avoidance.complianceMargin * 0.5;
    },
    get iterations() {
      return iterations;
    },
    get solveCalls() {
      return solveCalls;
    },
    get state() {
      if (paused) return 'paused';
      if (mode === 'target') return targetResult.resolved ? 'target-accepted' : 'target-held';
      if (result.resolved) return chased ? 'recovering' : clampActive ? 'sliding' : paced ? 'paced' : 'following';
      return rawStatus === 1 ? 'swivel-held' : rawStatus === 2 ? 'singular-held' : 'occluded-held';
    },
    get clock() {
      return clock;
    },
    get paused() {
      return paused;
    },
    get nominalHandSpeed() {
      return 0.75;
    },
    get paced() {
      return paced;
    },
    get handStep() {
      return handStep;
    },
    get acceptedPole() {
      return acceptedPole;
    },
    get angleStep() {
      return angleStep;
    },
    get targetClearance() {
      return targetClearance;
    },
    get clampActive() {
      return clampActive;
    },
    setPaused(value) {
      paused = Boolean(value);
      if (paused) {
        outwardDetour = false;
        handStep = 0;
        angleStep = 0;
        iterations = 0;
        solveCalls = 0;
      }
    },
    setMode(value) {
      if (value !== 'chain' && value !== 'target') throw new RangeError('Unknown query');
      mode = value;
    },
    setClock(value) {
      if (!['live', 'fixed60', 'fixed120'].includes(value)) throw new RangeError('Unknown clock');
      clock = value;
    },
    setYawAssist(value) {
      yawAssist = Boolean(value);
    },
  };
}
