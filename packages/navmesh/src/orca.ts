export interface Agent {id: number; position: readonly [number, number]; velocity: readonly [number, number]; preferred: readonly [number, number]; radius: number; maxSpeed: number}
interface Line {px: number; py: number; dx: number; dy: number}
const det = (x: number, y: number, u: number, v: number) => x * v - y * u;
// Half-plane records reused by every call (avoid is synchronous and never re-entered); each call overwrites the slots it uses.
const linePool: Line[] = [], projectedPool: Line[] = [];
function setLine(lines: Line[], at: number, px: number, py: number, dx: number, dy: number): void {
  const line = lines[at]; if (line) {line.px = px; line.py = py; line.dx = dx; line.dy = dy;} else lines[at] = {px, py, dx, dy};
}

function linear1(lines: Line[], index: number, radius: number, vx: number, vy: number, directional: boolean, out: Float64Array): boolean {
  const line = lines[index], b = line.px * line.dx + line.py * line.dy, discriminant = b * b + radius * radius - line.px * line.px - line.py * line.py;
  if (discriminant < 0) return false;
  const root = Math.sqrt(discriminant); let left = -b - root, right = -b + root;
  for (let i = 0; i < index; i++) {
    const previous = lines[i], denominator = det(line.dx, line.dy, previous.dx, previous.dy), numerator = det(previous.dx, previous.dy, line.px - previous.px, line.py - previous.py);
    if (Math.abs(denominator) < 1e-8) {if (numerator < 0) return false; continue;}
    const t = numerator / denominator; if (denominator >= 0) right = Math.min(right, t); else left = Math.max(left, t);
    if (left > right) return false;
  }
  const t = directional ? (vx * line.dx + vy * line.dy > 0 ? right : left) : Math.max(left, Math.min(right, line.dx * (vx - line.px) + line.dy * (vy - line.py)));
  out[0] = line.px + t * line.dx; out[1] = line.py + t * line.dy; return true;
}
function linear2(lines: Line[], count: number, radius: number, vx: number, vy: number, directional: boolean, out: Float64Array): number {
  const length = Math.hypot(vx, vy), scale = directional || length > radius ? radius / (length || 1) : 1; out[0] = vx * scale; out[1] = vy * scale;
  for (let i = 0; i < count; i++) {
    const line = lines[i]; if (det(line.dx, line.dy, line.px - out[0], line.py - out[1]) <= 0) continue;
    const x = out[0], y = out[1]; if (!linear1(lines, i, radius, vx, vy, directional, out)) {out[0] = x; out[1] = y; return i;}
  }
  return count;
}
function validate(agent: Agent): void {
  if (!Number.isSafeInteger(agent.id) || agent.position.length !== 2 || agent.velocity.length !== 2 || agent.preferred.length !== 2 ||
    !Number.isFinite(agent.radius) || agent.radius < 0 || !Number.isFinite(agent.maxSpeed) || agent.maxSpeed < 0 ||
    !Number.isFinite(agent.position[0]) || !Number.isFinite(agent.position[1]) || !Number.isFinite(agent.velocity[0]) || !Number.isFinite(agent.velocity[1]) ||
    !Number.isFinite(agent.preferred[0]) || !Number.isFinite(agent.preferred[1])) throw new RangeError('Invalid ORCA agent');
}

/** Reciprocal velocity-obstacle half-planes in XZ; returns a velocity within maxSpeed. */
export function avoid(agent: Agent, neighbors: readonly Agent[], delta = 1 / 60, horizon = 2, output = new Float64Array(2)): Float64Array {
  validate(agent);
  if (!Number.isFinite(delta) || delta <= 0 || !Number.isFinite(horizon) || horizon <= 0 || output.length !== 2 || neighbors.length > 4096) throw new RangeError('Invalid ORCA timestep or neighbor budget');
  const lines = linePool; let count = 0;
  for (const neighbor of neighbors) {
    validate(neighbor); if (neighbor.id === agent.id) continue;
    const px = neighbor.position[0] - agent.position[0], py = neighbor.position[1] - agent.position[1], vx = agent.velocity[0] - neighbor.velocity[0], vy = agent.velocity[1] - neighbor.velocity[1], distance2 = px * px + py * py, radius = agent.radius + neighbor.radius;
    let dx: number, dy: number, ux: number, uy: number;
    if (distance2 > radius * radius) {
      const wx = vx - px / horizon, wy = vy - py / horizon, length2 = wx * wx + wy * wy, dot = wx * px + wy * py;
      if (dot < 0 && dot * dot > radius * radius * length2) {
        const length = Math.sqrt(length2), nx = wx / length, ny = wy / length; dx = ny; dy = -nx;
        ux = (radius / horizon - length) * nx; uy = (radius / horizon - length) * ny;
      } else {
        const leg = Math.sqrt(distance2 - radius * radius);
        if (det(px, py, wx, wy) > 0) {dx = (px * leg - py * radius) / distance2; dy = (px * radius + py * leg) / distance2;}
        else {dx = -(px * leg + py * radius) / distance2; dy = -(-px * radius + py * leg) / distance2;}
        const projection = vx * dx + vy * dy; ux = projection * dx - vx; uy = projection * dy - vy;
      }
    } else {
      const wx = vx - px / delta, wy = vy - py / delta, length = Math.hypot(wx, wy), nx = length ? wx / length : agent.id < neighbor.id ? -1 : 1, ny = length ? wy / length : 0;
      dx = ny; dy = -nx; ux = (radius / delta - length) * nx; uy = (radius / delta - length) * ny;
    }
    setLine(lines, count++, agent.velocity[0] + ux * 0.5, agent.velocity[1] + uy * 0.5, dx, dy);
  }
  const failed = linear2(lines, count, agent.maxSpeed, agent.preferred[0], agent.preferred[1], false, output); let violation = 0;
  for (let i = failed; i < count; i++) {
    const line = lines[i], distance = det(line.dx, line.dy, line.px - output[0], line.py - output[1]); if (distance <= violation) continue;
    const projected = projectedPool; let projectedCount = 0;
    for (let j = 0; j < i; j++) {
      const previous = lines[j], denominator = det(line.dx, line.dy, previous.dx, previous.dy); let px: number, py: number;
      if (Math.abs(denominator) < 1e-8) {if (line.dx * previous.dx + line.dy * previous.dy > 0) continue; px = (line.px + previous.px) * 0.5; py = (line.py + previous.py) * 0.5;}
      else {const t = det(previous.dx, previous.dy, line.px - previous.px, line.py - previous.py) / denominator; px = line.px + t * line.dx; py = line.py + t * line.dy;}
      const dx = previous.dx - line.dx, dy = previous.dy - line.dy, length = Math.hypot(dx, dy); setLine(projected, projectedCount++, px, py, dx / length, dy / length);
    }
    const x = output[0], y = output[1]; if (linear2(projected, projectedCount, agent.maxSpeed, -line.dy, line.dx, true, output) < projectedCount) {output[0] = x; output[1] = y;}
    violation = det(line.dx, line.dy, line.px - output[0], line.py - output[1]);
  }
  return output;
}
