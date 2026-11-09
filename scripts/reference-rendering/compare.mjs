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
