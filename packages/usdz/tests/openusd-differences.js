// How a composed stage of ours differs from OpenUSD's reading of it (the `prims` mode of `oracle/truth.py`).

/** Equal within 1e-5 relative, arrays element by element. */
export const near = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) {
    const x = a.flat(9),
      y = b.flat(9);
    return x.length === y.length && x.every((v, i) => near(v, y[i]));
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
  return a === b;
};

/**
 * Every prim, type, target, connection, sample time and small value of OpenUSD's reading, against ours.
 * @param {Record<string, { specType: number, fields: Record<string, any> }>} specs
 * @param {{ prims: Record<string, { type: string, props: Record<string, any> }> }} want
 * @returns {string[]}
 */
export function differences(specs, want) {
  const out = [];
  for (const path of Object.keys(specs))
    if (specs[path].specType === 6 && !want.prims[path]) out.push(`prim ${path} should not be there`);
  for (const [path, prim] of Object.entries(want.prims)) {
    if (!specs[path]) {
      out.push(`prim ${path} is missing`);
      continue;
    }
    if ((specs[path].fields.typeName ?? '') !== prim.type) out.push(`type of ${path}`);
    for (const [name, expected] of Object.entries(prim.props)) {
      const fields = specs[path + '.' + name]?.fields;
      if (!fields) {
        if (!expected.t || expected.t.length) out.push(`property ${path}.${name} is missing`);
        continue;
      }
      if (expected.t && !near(fields.targetPaths ?? [], expected.t)) out.push(`targets of ${path}.${name}`);
      if (expected.conn && !near(fields.connectionPaths ?? [], expected.conn))
        out.push(`connections of ${path}.${name}`);
      if (expected.times && !near(fields.timeSamples?.times ?? [], expected.times))
        out.push(`times of ${path}.${name}`);
      if ('v' in expected && !expected.times && expected.v !== null && !near(fields.default, expected.v))
        out.push(`value of ${path}.${name}`);
    }
  }
  return out;
}
