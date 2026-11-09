import { hexColor } from '@margoengine/math';
import { rangeError } from '../../shared/errors.js';
import type { Light2D, LightMask2D } from './index.js';

/** Checks a finite scalar, optionally bounded below by zero or the smallest positive number. */
export function checkNumber(value: number, field: string, minimum = -Infinity): void {
  if (!Number.isFinite(value) || value < minimum) {
    const range = minimum === Number.MIN_VALUE ? ' and positive' : minimum === 0 ? ' and non-negative' : '';
    throw rangeError(`Invalid ${field}: must be finite${range}`, 'pixel-lighting');
  }
}

export function checkCamera(camera: {x: number; y: number; zoom: number}): void {
  checkNumber(camera.x, 'camera.x');
  checkNumber(camera.y, 'camera.y');
  checkNumber(camera.zoom, 'camera.zoom', Number.MIN_VALUE);
}

export function checkLayer(layer: number, field = 'layer'): void {
  if (!Number.isInteger(layer) || layer < 0 || layer > 0xffffffff)
    throw rangeError(`Invalid ${field}: must be an integer in [0, 4294967295]`, 'pixel-lighting');
}

function checkMask(m: LightMask2D): void {
  if (m.kind === 'rect') {
    if (![m.minX, m.minY, m.maxX, m.maxY].every(Number.isFinite) || m.minX > m.maxX || m.minY > m.maxY)
      throw rangeError('Invalid rect mask bounds: use finite minX <= maxX and minY <= maxY', 'pixel-lighting');
  } else if (m.kind === 'circle') {
    checkNumber(m.radius, 'circle mask radius', 0);
    if (m.center && (m.center.length !== 2 || !m.center.every(Number.isFinite)))
      throw rangeError('Invalid circle mask center: use two finite coordinates', 'pixel-lighting');
  } else if (m.kind === 'polygon') {
    if (!Array.isArray(m.points) || m.points.length < 3 || !m.points.every((p) => p.length === 2 && p.every(Number.isFinite)))
      throw rangeError('Invalid polygon mask points: use at least three points with two finite coordinates each', 'pixel-lighting');
  } else {
    throw rangeError('Invalid mask kind: use rect, circle or polygon', 'pixel-lighting');
  }
}

export function checkLight(l: Light2D): void {
  if (l.kind !== 'point' && l.kind !== 'spot' && l.kind !== 'directional')
    throw rangeError('Invalid light kind: use point, spot or directional', 'pixel-lighting');
  for (const field of ['x', 'y', 'angle', 'elevation'] as const) checkNumber(l[field], field);
  for (const field of ['radius', 'falloff', 'cone'] as const) checkNumber(l[field], field, Number.MIN_VALUE);
  for (const field of ['intensity', 'height'] as const) checkNumber(l[field], field, 0);
  if (!Number.isFinite(l.softness) || l.softness < 0 || l.softness > 1)
    throw rangeError('Invalid softness: must be finite and in [0, 1]', 'pixel-lighting');
  checkLayer(l.layers, 'layers');
  if (l.mask) checkMask(l.mask);
  if (!hexColor(l.color)) throw rangeError('Invalid light color: use a hex color such as #rrggbb', 'pixel-lighting');
}
