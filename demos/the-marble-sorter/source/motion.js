import { CatmullRomCurve3 } from '@margoengine/geometry/shapes';
import { DEFAULT_GRAVITY } from '@margoengine/math/gravity';
import { axisAngleToQuaternion, multiplyQuaternions, normalizeQuaternion } from '@margoengine/math/quat';

export const marbleRadius = .029;
export const railRadius = .0052;
export const gauge = .021;
export const gatePivot = [0, .396, .044];
export const gateReach = .158;
export const gateDrop = .043;
export const gateYaw = .43;
export const capacity = 6;
export const trayX = .445;
export const trayFloor = .057;

const gravity = -DEFAULT_GRAVITY[1];
export const railCenterDrop = Math.sqrt((marbleRadius + railRadius) ** 2 - gauge ** 2);
const rollingRadius = railCenterDrop * marbleRadius / (marbleRadius + railRadius);
const rotationalInertia = .4 * (marbleRadius / rollingRadius) ** 2;
const approachLock = .218;
const resistance = .052;
const feedPoints = [
  [-.53, .695, -.365], [-.52, .65, -.505], [-.36, .61, -.537], [-.166, .564, -.465],
  [-.053, .503, -.319], [-.003, .446, -.161], gatePivot,
];

const mix = (a, b, t) => a + (b - a) * t;
const pointBetween = (a, b, t) => a.map((coordinate, i) => mix(coordinate, b[i], t));
const distance = (a, b) => Math.hypot(...a.map((coordinate, i) => coordinate - b[i]));
export const turnFor = (side) => side === 'left' ? -gateYaw : gateYaw;

function sampledPath(points, divisions) {
  const curve = new CatmullRomCurve3(points);
  const steps = Array.from({ length: divisions + 1 }, (_, i) => curve.getPoint(i / divisions));
  const lengths = [0];
  for (let index = 1; index < steps.length; index++) {
    lengths.push(lengths[index - 1] + distance(steps[index], steps[index - 1]));
  }
  return {
    steps, length: lengths.at(-1),
    at(arc) {
      let low = 0, high = divisions;
      while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (lengths[middle] <= arc) low = middle;
        else high = middle;
      }
      return pointBetween(steps[low], steps[high], Math.max(0, Math.min(1,
        (arc - lengths[low]) / (lengths[high] - lengths[low]))));
    },
  };
}

function gateTip(yaw) {
  return [gatePivot[0] + gateReach * Math.sin(yaw), gatePivot[1] - gateDrop, gatePivot[2] + gateReach * Math.cos(yaw)];
}

export const feed = sampledPath(feedPoints, 120);
export const queues = Object.fromEntries(['left', 'right'].map((side) => {
  const sign = side === 'left' ? -1 : 1;
  const tip = gateTip(turnFor(side));
  const path = sampledPath([
    tip, [tip[0] + sign * .049, .315, tip[2] + .095],
    [sign * .237, .258, .305], [sign * .379, .193, .323], [sign * trayX, .147, .365],
  ], 82);
  return [side, { tip, path }];
}));

function landingSlot(side, slot) {
  const sign = side === 'left' ? -1 : 1;
  const offsets = [0, .065, -.065];
  return [sign * (trayX + offsets[slot % 3]), trayFloor + marbleRadius, slot < 3 ? .554 : .481];
}

export function createSorter() {
  let selected = 'left', angle = turnFor(selected), marble = null, settled = [];
  const counts = { left: 0, right: 0 };
  const canSelect = () => !marble || marble.stage !== 'bridge' &&
    (marble.stage !== 'feed' || feed.length - marble.arc > approachLock);
  const heading = () => !marble ? 'ready' : marble.stage;
  const next = () => settled.length;

  function rotate(item, previous, point, travel) {
    const dx = point[0] - previous[0], dz = point[2] - previous[2];
    const n = Math.hypot(dx, dz);
    if (n <= 1e-10) return;
    const quaternion = axisAngleToQuaternion([dz / n, 0, -dx / n], travel /
      (item.stage === 'tray' ? marbleRadius : rollingRadius));
    item.rotation = normalizeQuaternion(multiplyQuaternions(quaternion, item.rotation));
  }

  function roll(item, dt) {
    let remaining = dt;
    while (remaining > 1e-6 && item.stage !== 'tray') {
      const energy = .008 + 2 * gravity * (feed.steps[0][1] - item.position[1]) / (1 + rotationalInertia)
        - 2 * resistance * item.distance;
      item.speed = Math.sqrt(Math.max(.008, energy));
      const length = item.stage === 'feed' ? feed.length
        : item.stage === 'bridge' ? distance(gatePivot, queues[item.side].tip) : queues[item.side].path.length;
      const travel = Math.min(length - item.arc, item.speed * remaining);
      item.arc += travel;
      item.distance += travel;
      const point = item.stage === 'feed' ? feed.at(item.arc)
        : item.stage === 'bridge' ? pointBetween(gatePivot, queues[item.side].tip, item.arc / length)
        : queues[item.side].path.at(item.arc);
      rotate(item, item.position, point, travel);
      item.position = point;
      remaining -= travel / item.speed;
      if (length - item.arc > 1e-7) break;
      item.arc = 0;
      if (item.stage === 'feed') {
        item.side = selected;
        item.stage = 'bridge';
      } else if (item.stage === 'bridge') {
        item.stage = 'branch';
      } else {
        item.stage = 'tray';
        item.entry = item.position;
        item.target = landingSlot(item.side, counts[item.side]);
        item.trayTime = 0;
        item.fall = Math.sqrt(2 * (item.entry[1] - item.target[1]) / gravity);
      }
    }
    return remaining;
  }

  function tray(item, dt) {
    const elapsed = item.trayTime += dt;
    const to = item.target, from = item.entry;
    const rollTime = .65, fraction = Math.min(1, elapsed / (item.fall + rollTime));
    const progress = 1 - (1 - fraction) ** 3;
    const point = pointBetween(from, to, progress);
    const rebound = elapsed - item.fall, impactSpeed = gravity * item.fall;
    if (rebound < 0) {
      point[1] = from[1] - .5 * gravity * elapsed ** 2;
    } else {
      const bump = .22 * impactSpeed * rebound - .5 * gravity * rebound ** 2;
      point[1] = to[1] + Math.max(0, bump);
    }
    rotate(item, item.position, point, Math.hypot(point[0] - item.position[0], point[2] - item.position[2]));
    item.position = point;
    if (fraction < 1) return;
    counts[item.side]++;
    settled.push(item);
    marble = null;
  }

  return {
    get selected() { return selected; },
    get angle() { return angle; },
    get marble() { return marble; },
    get settled() { return settled; },
    get counts() { return counts; },
    get next() { return next(); },
    get phase() { return heading(); },
    get canSelect() { return canSelect(); },
    get canDrop() { return !marble && counts[selected] < capacity; },
    get moving() { return !!marble || angle !== turnFor(selected); },
    select(side) {
      if (!canSelect() || counts[side] >= capacity) return;
      selected = side;
    },
    drop() {
      if (marble || counts[selected] >= capacity) return;
      marble = { index: next(), stage: 'feed', arc: 0, distance: 0, speed: 0,
        position: feed.steps[0], rotation: axisAngleToQuaternion([0, 1, 0], next() * 1.21) };
    },
    reset() {
      selected = 'left';
      angle = turnFor(selected);
      marble = null;
      settled = [];
      counts.left = counts.right = 0;
    },
    update(dt, snapGate = false) {
      const target = turnFor(selected);
      const change = target - angle;
      angle = snapGate || Math.abs(change) < dt * 12 ? target : angle + Math.sign(change) * dt * 12;
      if (!marble) return;
      const rest = marble.stage === 'tray' ? dt : roll(marble, dt);
      if (marble?.stage === 'tray' && rest > 0) tray(marble, rest);
    },
  };
}
