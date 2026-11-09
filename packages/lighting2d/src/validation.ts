import { hexColor } from '@margoengine/math';
import { rangeError } from '../../shared/errors.js';
import type { Light2D, LightMask2D } from './index.js';
const invalid = () => rangeError('Invalid light value', 'pixel-lighting');

export function checkCamera(camera: {x: number; y: number; zoom: number}): void {
  if (![camera.x, camera.y, camera.zoom].every(Number.isFinite) || camera.zoom <= 0) throw invalid();
}

export function checkLayer(layer: number): void {
  if (!Number.isInteger(layer) || layer < 0 || layer > 0xffffffff) throw invalid();
}

function checkMask(m: LightMask2D): boolean {
  if (m.kind === 'rect') {
    return [m.minX, m.minY, m.maxX, m.maxY].every(Number.isFinite) && m.minX <= m.maxX && m.minY <= m.maxY;
  } else if (m.kind === 'circle') {
    return Number.isFinite(m.radius) && m.radius >= 0 && (!m.center || (m.center.length === 2 && m.center.every(Number.isFinite)));
  } else if (m.kind === 'polygon') {
    return Array.isArray(m.points) && m.points.length >= 3 && m.points.every((p) => p.length === 2 && p.every(Number.isFinite));
  }
  return false;
}

export function checkLight(l: Light2D): void {
  const good =
    (l.kind === 'point' || l.kind === 'spot' || l.kind === 'directional') &&
    [l.x, l.y, l.angle, l.elevation].every(Number.isFinite) &&
    l.intensity >= 0 &&
    l.radius > 0 &&
    l.falloff > 0 &&
    l.height >= 0 &&
    l.cone > 0 &&
    l.softness >= 0 &&
    l.softness <= 1 &&
    [l.intensity, l.radius, l.falloff, l.height, l.cone].every(Number.isFinite) &&
    Number.isInteger(l.layers) &&
    l.layers >= 0 &&
    l.layers <= 0xffffffff &&
    (!l.mask || checkMask(l.mask)) &&
    !!hexColor(l.color);
  if (!good) throw invalid();
}
