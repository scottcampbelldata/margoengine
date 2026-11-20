// The stress stages of `oracle/generate-stages.py`, written in JavaScript so a CPU test can build them without Python.
// The same seed gives the same files byte for byte: the generator draws from a Mersenne Twister (MT19937, Matsumoto and
// Nishimura 1998, "Mersenne Twister: a 623-dimensionally equidistributed uniform pseudo-random number generator", ACM
// TOMACS 8(1), https://doi.org/10.1145/272991.272995) seeded the way Python's `random.Random(int)` documents it, an
// `init_by_array` of the seed's 32-bit words, with `random()` built from 53 bits of two outputs and `randint` and `choice`
// drawing `k` bits for a range of `k` bits and drawing again on a value past the range.

/** A Python-compatible `random.Random(seed)` for a seed below 2^32. */
function pythonRandom(seed) {
  const mt = new Uint32Array(624);
  let index = 624;
  const mul = (a, b) => Math.imul(a, b) >>> 0;
  mt[0] = 19650218;
  for (let i = 1; i < 624; i++) mt[i] = (mul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
  const key = [seed >>> 0];
  let i = 1;
  let j = 0;
  for (let k = Math.max(624, key.length); k; k--) {
    mt[i] = ((mt[i] ^ mul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
    i++;
    j++;
    if (i >= 624) {
      mt[0] = mt[623];
      i = 1;
    }
    if (j >= key.length) j = 0;
  }
  for (let k = 623; k; k--) {
    mt[i] = ((mt[i] ^ mul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
    i++;
    if (i >= 624) {
      mt[0] = mt[623];
      i = 1;
    }
  }
  mt[0] = 0x80000000;
  const next = () => {
    if (index >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = (mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
      }
      index = 0;
    }
    let y = mt[index++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    return (y ^ (y >>> 18)) >>> 0;
  };
  const below = (n) => {
    const bits = 32 - Math.clz32(n);
    for (;;) {
      const r = next() >>> (32 - bits);
      if (r < n) return r;
    }
  };
  return {
    random: () => ((next() >>> 5) * 67108864 + (next() >>> 6)) / 9007199254740992,
    randint: (a, b) => a + below(b - a + 1),
    choice: (list) => list[below(list.length)],
  };
}

/**
 * The stages `generate-stages.py out count seed` writes, as `[{ 'root.usda': text, 'l0.usda': text, ... }]`.
 * @param {number} count
 * @param {number} seed
 */
export function stressStages(count, seed) {
  const rnd = pythonRandom(seed);
  const names = ['a', 'b', 'c'];
  const attrs = (ind) => {
    const lines = [];
    for (let k = 0; k < 4; k++) {
      if (rnd.random() < 0.6) {
        const r = rnd.random();
        if (r < 0.2)
          lines.push(
            `${ind}custom double v${k}.timeSamples = { ${rnd.randint(0, 3)}: ${rnd.randint(1, 99)}, ${rnd.randint(4, 9)}: ${rnd.randint(1, 99)} }`,
          );
        else if (r < 0.3) lines.push(`${ind}custom double v${k} = None`);
        else lines.push(`${ind}custom double v${k} = ${rnd.randint(1, 999)}`);
      }
    }
    if (rnd.random() < 0.3) {
      const edit = rnd.choice(['', 'prepend ', 'append ', 'delete ', 'add ']);
      lines.push(
        edit === ''
          ? `${ind}${edit}custom rel r = [<${rnd.choice(['/Shared', '/M/a', '/C/b', '/Y'])}>]`
          : `${ind}${edit}rel r = [<${rnd.choice(['/Shared', '/M/a', '/C/b'])}>]`,
      );
    }
    return lines;
  };
  const prim = (spec, name, depth, classes, files, layerPrims, ind) => {
    const meta = [];
    if (rnd.random() < 0.35 && classes.length)
      meta.push(`${rnd.choice(['', 'prepend ', 'append '])}inherits = <${rnd.choice(classes)}>`);
    if (rnd.random() < 0.2 && classes.length) meta.push(`specializes = <${rnd.choice(classes)}>`);
    if (rnd.random() < 0.4 && files.length) {
      const f = rnd.choice(files);
      const target = rnd.choice(['', '</M>', '</M/a>']);
      const offset = rnd.choice(['', ' (offset = 10)', ' (offset = 3; scale = 2)']);
      const kind = rnd.choice(['references', 'payload', 'prepend references', 'append references']);
      meta.push(`${kind} = @./${f}@${target}${offset}`);
    }
    if (rnd.random() < 0.15 && layerPrims.length) meta.push(`references = <${rnd.choice(layerPrims)}>`);
    const vs = rnd.random() < 0.3;
    if (vs) {
      meta.push('variantSets = "vs"');
      if (rnd.random() < 0.7) meta.push(`variants = { string vs = "${rnd.choice(['x', 'y'])}" }`);
    }
    const head = `${ind}${spec} "${name}"`;
    const lines = [
      head + (meta.length ? ' (\n' + meta.map((m) => `${ind}    ${m}\n`).join('') + `${ind})` : ''),
      `${ind}{`,
    ];
    lines.push(...attrs(ind + '    '));
    if (depth < 2)
      for (const n of names)
        if (rnd.random() < 0.45)
          lines.push(
            ...prim(rnd.choice(['def', 'def', 'over']), n, depth + 1, classes, files, layerPrims, ind + '    '),
          );
    if (vs) {
      lines.push(`${ind}    variantSet "vs" = {`);
      for (const sel of ['x', 'y']) {
        lines.push(`${ind}        "${sel}" {`);
        lines.push(...attrs(ind + '            '));
        if (rnd.random() < 0.5)
          lines.push(...prim('def', rnd.choice(names), 2, classes, files, [], ind + '            '));
        lines.push(`${ind}        }`);
      }
      lines.push(`${ind}    }`);
    }
    lines.push(`${ind}}`);
    return lines;
  };
  const stages = [];
  for (let i = 0; i < count; i++) {
    const stage = {};
    const files = [];
    for (const [j, file] of ['l0.usda', 'l1.usda', 'l2.usda'].entries()) {
      const head = ['#usda 1.0', '(', '    defaultPrim = "M"'];
      if (j && rnd.random() < 0.3)
        head.push(`    subLayers = [@./${rnd.choice(files)}@ (offset = ${rnd.randint(0, 5)})]`);
      head.push(')');
      const body = [
        ...prim('class', 'C', 0, [], [], [], ''),
        ...prim('def', 'Shared', 1, [], [], [], ''),
        ...prim('def', 'M', 0, ['/C', '/C/a'], [...files], ['/Shared'], ''),
        ...prim(rnd.choice(['def', 'over']), 'Y', 1, ['/C'], [...files], ['/Shared', '/M'], ''),
      ];
      stage[file] = [...head, ...body].join('\n') + '\n';
      files.push(file);
    }
    const root = [
      '#usda 1.0',
      '(',
      rnd.random() < 0.3 ? '    subLayers = [@./l1.usda@ (offset = 7), @./l0.usda@]' : '',
      ')',
    ];
    const body = [...prim('class', 'C', 0, [], [], [], ''), ...prim('def', 'Shared', 1, [], [], [], '')];
    for (const n of ['P', 'Q', 'R']) body.push(...prim('def', n, 0, ['/C'], [...files], ['/Shared'], ''));
    stage['root.usda'] = [...root, ...body].join('\n') + '\n';
    stages.push(stage);
  }
  return stages;
}
