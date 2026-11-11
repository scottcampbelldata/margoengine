import assert from 'node:assert/strict';

/** Integer RGB error over every pixel, including silhouettes; foreground is the nonblack union. */
export function pictureError(actual, reference) {
  assert.equal(actual.width, reference.width);
  assert.equal(actual.height, reference.height);
  const count = actual.width * actual.height;
  assert.equal(actual.data.length, count * 4);
  assert.equal(reference.data.length, count * 4);
  let absolute = 0,
    square = 0,
    max = 0,
    foreground = 0,
    foregroundAbsolute = 0,
    changed = 0;
  for (let p = 0; p < count; p++) {
    let active = false,
      differs = false,
      delta = 0;
    for (let c = 0; c < 3; c++) {
      const a = actual.data[p * 4 + c],
        b = reference.data[p * 4 + c];
      assert.ok(Number.isInteger(a) && a >= 0 && a <= 255 && Number.isInteger(b) && b >= 0 && b <= 255);
      const d = Math.abs(a - b);
      absolute += d;
      delta += d;
      square += d * d;
      max = Math.max(max, d);
      active ||= a !== 0 || b !== 0;
      differs ||= d !== 0;
    }
    if (active) {
      foreground++;
      foregroundAbsolute += delta;
    }
    if (differs) changed++;
  }
  assert.ok(foreground > 0, 'Both pictures are black');
  return {
    pixels: count,
    absolute,
    square,
    max,
    mae: absolute / (count * 3),
    rmse: Math.sqrt(square / (count * 3)),
    foreground,
    foregroundAbsolute,
    foregroundMae: foregroundAbsolute / (foreground * 3),
    changed,
  };
}

export function assertBudget(result, budget) {
  for (const key of ['absolute', 'square', 'max'])
    assert.ok(result[key] <= budget[key], `${key}: ${result[key]} > measured ${budget[key]}`);
  assert.ok(result.foreground >= budget.foreground, 'Lost foreground coverage');
}

/**
 * Splits the absolute RGB error of `actual` against `reference` into edge and flat pixels. Edge pixels are those whose
 * `edges` picture (the frozen reference) changes by more than 30 summed RGB levels to a 4-neighbour: silhouettes and
 * contacts, where antialiasing and visibility differ most. `flatSigned` is the signed flat sum (positive: brighter).
 */
export function edgeSplit(actual, reference, edges) {
  const { width, height } = edges,
    level = (p) => edges.data[p * 4] + edges.data[p * 4 + 1] + edges.data[p * 4 + 2];
  let edge = 0,
    flat = 0,
    flatSigned = 0,
    edgePixels = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let error = 0,
        signed = 0,
        step = 0;
      for (let c = 0; c < 3; c++) {
        error += Math.abs(actual.data[p * 4 + c] - reference.data[p * 4 + c]);
        signed += actual.data[p * 4 + c] - reference.data[p * 4 + c];
      }
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const q = Math.min(height - 1, Math.max(0, y + dy)) * width + Math.min(width - 1, Math.max(0, x + dx));
        step = Math.max(step, Math.abs(level(p) - level(q)));
      }
      if (step > 30) {
        edge += error;
        edgePixels++;
      } else {
        flat += error;
        flatSigned += signed;
      }
    }
  return { edgePixels, edge, flat, flatSigned };
}
