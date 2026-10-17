import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

// Parallel worktrees supply their shared adapter lock using MARGO_GPU_LOCK.
const release = await acquire({ owner: 'material-render-state-gpu-check' }),
  output = 'test-results/material-render-state',
  report = { checks: [], failures: [], captures: [] },
  points = [
    [80, 120],
    [160, 120],
    [240, 120],
  ],
  instancePoints = [
    [80, 120],
    [240, 120],
  ],
  red = [255, 0, 0, 255],
  green = [0, 255, 0, 255],
  blue = [0, 0, 255, 255],
  compares = ['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'],
  operations = [
    'keep',
    'zero',
    'replace',
    'invert',
    'increment-clamp',
    'decrement-clamp',
    'increment-wrap',
    'decrement-wrap',
  ];
let browser,
  samples = 4;
function check(name, actual, expected) {
  report.checks.push({ name, samples, actual, expected });
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    report.failures.push(`${samples}x ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
// Independent 8-bit stencil arithmetic. The raster implementation never provides these expected values.
function compare(op, reference, stored) {
  return {
    never: false,
    less: reference < stored,
    equal: reference === stored,
    'less-equal': reference <= stored,
    greater: reference > stored,
    'not-equal': reference !== stored,
    'greater-equal': reference >= stored,
    always: true,
  }[op];
}
function operation(op, stored, reference) {
  return {
    keep: stored,
    zero: 0,
    replace: reference & 255,
    invert: ~stored & 255,
    'increment-clamp': Math.min(255, stored + 1),
    'decrement-clamp': Math.max(0, stored - 1),
    'increment-wrap': (stored + 1) & 255,
    'decrement-wrap': (stored - 1) & 255,
  }[op];
}
function stencil(face, reference = 0, extra = {}) {
  return { stencilFront: { ...face }, stencilBack: { ...face }, stencilReference: reference, ...extra };
}
function writer(reference = 1, extra = {}, options = {}) {
  return {
    options: { color: [1, 0, 0], ...options },
    state: {
      colorWrite: false,
      depthWrite: false,
      depthCompare: 'always',
      ...stencil({ compare: 'always', passOp: 'replace' }, reference),
      ...extra,
    },
  };
}
function reader(reference = 1, func = 'equal', extra = {}) {
  return {
    options: { color: [0, 0, 1], side: 'double' },
    state: {
      depthWrite: false,
      depthCompare: 'always',
      ...stencil({ compare: func }, reference, { stencilWriteMask: 0 }),
      ...extra,
    },
  };
}
try {
  await mkdir(output, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/material-render-state.html', port: 5219 });
  report.hardware = browser.hardware;
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical GPU required');
  const page = browser.page,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => window.renderStateFixture);
  const baseline = await access('test-results/pre-render-state-materials-dist/index.js').then(
    () => true,
    () => false,
  );
  report.legacyBaselineAvailable = baseline;
  async function read(label, state, selected = points) {
    const image = await page.evaluate((points) => window.renderStateFixture.read(points), selected);
    report.captures.push({ label, samples, state, image });
    return { image, state };
  }
  async function render(label, draws, variant = {}, selected = points) {
    const state = await page.evaluate(({ draws, variant }) => window.renderStateFixture.render(draws, variant), {
      draws,
      variant,
    });
    check(label + ' actual samples', state.sampleCount, samples);
    return read(label, state, selected);
  }
  function colors(label, actual, expected) {
    check(
      label,
      actual.image.map((p) => p.rgba),
      actual.image.map((_, i) => (typeof expected === 'function' ? expected(i) : expected)),
    );
  }
  for (samples of [4, 1]) {
    if (samples === 1) {
      await page.goto('http://127.0.0.1:5219/tests/material-render-state.html?samples=1');
      await page.waitForFunction(() => window.renderStateFixture);
    }
    const empty = await render('empty', []),
      blank = empty.image[0].rgba;
    check('physical device stencil feature', empty.state.stencilFeature, true);
    check('raw target has stencil', empty.state.format, 'depth32float-stencil8');
    const defaults = await render('public-defaults', [{ options: {} }]);
    check('public render-state defaults', defaults.state.properties[0], {
      colorWrite: true,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      polygonOffsetClamp: 0,
      stencilWrite: false,
      stencilFunc: 'always',
      stencilRef: 0,
      stencilReadMask: 255,
      stencilWriteMask: 255,
      stencilFail: 'keep',
      stencilZFail: 'keep',
      stencilZPass: 'keep',
    });
    for (const [name, state, slope, expected] of [
      ['native-no-bias', { depthCompare: 'greater' }, 0, green],
      ['native-positive-units', { depthCompare: 'greater', depthBias: 2048 }, 0, red],
      ['native-negative-units', { depthCompare: 'greater', depthBias: -2048 }, 0, green],
      ['native-positive-slope', { depthCompare: 'greater', depthBiasSlopeScale: 2 }, 0.2, red],
      ['native-negative-slope', { depthCompare: 'greater', depthBiasSlopeScale: -2 }, 0.2, green],
    ]) {
      const actual = await render(name, [
        { options: { color: [0, 1, 0] }, slope },
        { options: { color: [1, 0, 0] }, slope, state },
      ]);
      colors(name + ' reverse-Z independent pixel oracle', actual, expected);
    }
    for (const [name, options, slope, expected] of [
      ['material-positive-units-away', { polygonOffset: true, polygonOffsetUnits: 2048 }, 0, green],
      ['material-negative-units-forward', { polygonOffset: true, polygonOffsetUnits: -2048 }, 0, red],
      ['material-disabled-units-inactive', { polygonOffset: false, polygonOffsetUnits: -2048 }, 0, red],
      ['material-positive-factor-away', { polygonOffset: true, polygonOffsetFactor: 2 }, 0.2, green],
      ['material-negative-factor-forward', { polygonOffset: true, polygonOffsetFactor: -2 }, 0.2, red],
    ]) {
      const actual = await render(name, [
        { options: { color: [0, 1, 0] }, slope },
        { options: { color: [1, 0, 0], ...options }, slope },
      ]);
      colors(name + ' independent pixel oracle', actual, expected);
    }
    for (const [name, state, expected] of [
      ['native-unclamped', { depthBias: 100000 }, red],
      ['native-clamped', { depthBias: 100000, depthBiasClamp: 1e-6 }, green],
    ]) {
      const actual = await render(name, [
        { options: { color: [0, 1, 0] } },
        { options: { color: [1, 0, 0] }, z: -0.001, state },
      ]);
      colors(name + ' limits depth shift', actual, expected);
    }
    for (const [name, options, expected] of [
      ['material-unclamped', { polygonOffset: true, polygonOffsetUnits: -100000 }, red],
      ['material-clamped', { polygonOffset: true, polygonOffsetUnits: -100000, polygonOffsetClamp: -1e-6 }, green],
    ]) {
      const actual = await render(name, [
        { options: { color: [0, 1, 0] } },
        { options: { color: [1, 0, 0], ...options }, z: -0.001 },
      ]);
      colors(name + ' limits depth shift', actual, expected);
    }
    for (const [name, options, slope, expected] of [
      ['units-away', { polygonOffset: true, polygonOffsetUnits: 2048 }, 0, green],
      ['units-forward', { polygonOffset: true, polygonOffsetUnits: -2048 }, 0, red],
      ['factor-away', { polygonOffset: true, polygonOffsetFactor: 2 }, 0.2, green],
      ['factor-forward', { polygonOffset: true, polygonOffsetFactor: -2 }, 0.2, red],
    ])
      colors(
        'forward-Z createRenderer public ' + name,
        await render(
          'forward-public-' + name,
          [
            { options: { color: [0, 1, 0] }, slope },
            { options: { color: [1, 0, 0], ...options }, slope },
          ],
          { forward: true },
        ),
        expected,
      );
    for (const [bias, expected] of [
      [2048, green],
      [-2048, red],
    ])
      colors(
        'forward-Z native GPU bias convention ' + bias,
        await render(
          'forward-native-' + bias,
          [{ options: { color: [0, 1, 0] } }, { state: { depthCompare: 'less', depthBias: bias } }],
          { forward: true },
        ),
        expected,
      );
    const publicMapping = await render('public-exact-native-mapping', [
      {
        options: {
          colorWrite: false,
          polygonOffset: true,
          polygonOffsetUnits: 12345,
          polygonOffsetFactor: 0.7,
          polygonOffsetClamp: 0.00007,
          stencilWrite: true,
          stencilFunc: 'not-equal',
          stencilRef: 19,
          stencilReadMask: 37,
          stencilWriteMask: 81,
          stencilFail: 'invert',
          stencilZFail: 'increment-clamp',
          stencilZPass: 'replace',
        },
      },
    ]);
    check(
      'public reverse-Z bias maps native signs and color mask',
      publicMapping.state.descriptors.some(
        (d) =>
          d.depthStencil?.depthBias === -12345 &&
          d.depthStencil.depthBiasSlopeScale === -0.7 &&
          d.depthStencil.depthBiasClamp === -0.00007 &&
          d.writeMask === 0,
      ),
      true,
    );
    colors(
      'native colorWrite=false masks all channels',
      await render('native-color-write-off', [{ state: { colorWrite: false } }]),
      blank,
    );
    colors(
      'public colorWrite=false masks all channels',
      await render('public-color-write-off', [{ options: { colorWrite: false } }]),
      blank,
    );
    colors(
      'invisible color writer still writes depth',
      await render('color-off-still-depth', [
        { options: { color: [0, 1, 0] }, z: -1 },
        { options: { colorWrite: false }, z: 1 },
        { options: { color: [0, 0, 1] } },
      ]),
      green,
    );
    colors(
      'public color-off depthWrite=false leaves depth untouched',
      await render('color-off-no-depth', [
        { options: { color: [0, 1, 0] }, z: -1 },
        { options: { colorWrite: false, depthWrite: false }, z: 1 },
        { options: { color: [0, 0, 1] } },
      ]),
      blue,
    );
    for (const func of compares) {
      const reference = 3,
        stored = 5,
        actual = await render('native-compare-' + func, [reader(reference, func)], { clear: stored });
      colors(
        func + ' compares reference against stored stencil',
        actual,
        compare(func, reference, stored) ? blue : blank,
      );
      const publicActual = await render(
        'material-compare-' + func,
        [
          {
            options: {
              color: [0, 0, 1],
              depthWrite: false,
              stencilWrite: true,
              stencilFunc: func,
              stencilRef: reference,
              stencilWriteMask: 0,
            },
          },
        ],
        { clear: stored },
      );
      colors(func + ' public stencil compare', publicActual, compare(func, reference, stored) ? blue : blank);
    }
    colors(
      'stencil options inactive while stencilWrite=false',
      await render('public-stencil-disabled', [
        { options: { stencilWrite: false, stencilFunc: 'never', stencilRef: 7 } },
      ]),
      red,
    );
    for (const [phase, condition] of [
      ['passOp', { compare: 'always' }],
      ['failOp', { compare: 'never' }],
      ['depthFailOp', { compare: 'always' }],
    ])
      for (const op of operations) {
        const stored = 0x35,
          reference = 0x17,
          expected = operation(op, stored, reference),
          face = { ...condition, [phase]: op },
          draw = writer(reference, {
            ...stencil(face, reference),
            depthCompare: phase === 'depthFailOp' ? 'never' : 'always',
          }),
          actual = await render(`native-${phase}-${op}`, [draw, reader(expected)], { clear: stored });
        colors(`${phase} ${op} matches independent 8-bit stencil arithmetic`, actual, blue);
      }
    for (const [op, stored] of [
      ['increment-clamp', 255],
      ['increment-wrap', 255],
      ['decrement-clamp', 0],
      ['decrement-wrap', 0],
    ]) {
      const expected = operation(op, stored, 0),
        actual = await render(
          `native-endpoint-${op}`,
          [writer(0, stencil({ compare: 'always', passOp: op }, 0)), reader(expected)],
          { clear: stored },
        );
      colors(op + ' endpoint distinguishes clamp and wrap', actual, blue);
    }
    for (const [mask, expected] of [
      [15, blue],
      [240, blank],
    ])
      colors(
        'read mask ' + mask,
        await render('native-read-mask-' + mask, [reader(0x15, 'equal', { stencilReadMask: mask })], { clear: 0xa5 }),
        expected,
      );
    colors(
      'write mask preserves untouched stencil bits',
      await render('native-write-mask', [writer(0x15, { stencilWriteMask: 15 }), reader(0xa5)], { clear: 0xa0 }),
      blue,
    );
    colors(
      'reference uses eight-bit stencil target mask',
      await render('native-reference-high-bits', [reader(0x1000005)], { clear: 5 }),
      blue,
    );
    for (const [phase, field] of [
      ['pass', 'stencilZPass'],
      ['fail', 'stencilFail'],
      ['depth-fail', 'stencilZFail'],
    ])
      for (const op of operations) {
        const stored = 0x35,
          reference = 0x17,
          expected = operation(op, stored, reference),
          draw = {
            options: {
              colorWrite: false,
              depthWrite: false,
              stencilWrite: true,
              stencilFunc: phase === 'fail' ? 'never' : 'always',
              stencilRef: reference,
              [field]: op,
            },
          },
          draws =
            phase === 'depth-fail'
              ? [{ options: { color: [0, 1, 0] }, z: 1 }, draw, reader(expected)]
              : [draw, reader(expected)];
        colors(
          `public ${field} ${op} independent stencil arithmetic`,
          await render(`public-${phase}-${op}`, draws, { clear: stored }),
          blue,
        );
      }
    const mask = writer(7);
    mask.bounds = [-1.8, 0, -1.3, 1.3];
    colors(
      'stencil mask selects left half without writing color/depth',
      await render('left-mask', [mask, reader(7)]),
      (i) => (i === 0 ? blue : blank),
    );
    const referenceReset = await render(
      'one-pass-reference-reset',
      [
        mask,
        reader(7),
        { ...reader(0), options: { color: [0, 1, 0] }, state: { ...reader(0).state, stencilReference: undefined } },
      ],
      { combined: true },
      instancePoints,
    );
    colors('omitted reference resets to zero inside one shared pass', referenceReset, (i) => (i === 0 ? blue : green));
    check('renderer explicitly resets dynamic reference', referenceReset.state.references.includes(0), true);
    for (const back of [false, true])
      for (const instances of [false, true]) {
        const state = {
            colorWrite: false,
            depthWrite: false,
            depthCompare: 'always',
            stencilFront: { compare: 'always', passOp: 'replace' },
            stencilBack: { compare: 'always', passOp: 'zero' },
            stencilReference: 9,
          },
          draws = instances
            ? [{ options: { side: 'double' }, state, instances: true }]
            : [
                { options: { side: 'double' }, state, x: -1, bounds: [-0.65, 0.65, -1.1, 1.1] },
                { options: { side: 'double' }, state, x: 1, bounds: [-0.65, 0.65, -1.1, 1.1], mirror: true },
              ],
          actual = await render(
            `per-face-${back}-${instances}`,
            [...draws, reader(9)],
            { back, clear: 3 },
            instancePoints,
          );
        colors('separate literal front/back stencil operations with mirrors', actual, (i) => (i === 0 ? blue : blank));
      }
    for (const back of [false, true]) {
      const symmetric = writer(9).state,
        asymmetric = {
          ...symmetric,
          stencilBack: { compare: 'always', passOp: 'zero' },
        },
        label = 'static-coalesced-mirrors-' + back;
      colors(
        'shared static glTF material writes both mirrored nodes with symmetric stencil faces',
        await render(label, [{ staticMirrors: true, state: symmetric }, reader(9)], { back, clear: 3 }, instancePoints),
        blue,
      );
      const enabled = await page.evaluate((state) => window.renderStateFixture.liveNative(0, state), asymmetric);
      colors(
        'live asymmetric stencil faces retain original winding of coalesced mirrored glTF nodes',
        await read(label + '-asymmetric', enabled, instancePoints),
        (i) => (i === 0 ? blue : blank),
      );
      const restored = await page.evaluate((state) => window.renderStateFixture.liveNative(0, state), symmetric);
      colors(
        'restoring symmetric stencil faces draws both shared static glTF nodes',
        await read(label + '-symmetric-restored', restored, instancePoints),
        blue,
      );
    }
    const alphaMask = writer(1);
    alphaMask.alphaMask = true;
    colors(
      'alpha-discarded fragments do not update stencil',
      await render('alpha-mask-stencil', [alphaMask, reader(1)], {}, instancePoints),
      (i) => (i === 0 ? blank : blue),
    );
    for (const op of ['increment-clamp', 'invert'])
      for (const back of [false, true])
        for (const instances of [false, true]) {
          const stored = op === 'invert' ? 0x35 : 0,
            expected = operation(op, stored, 0),
            physical = writer(0, stencil({ compare: 'always', passOp: op }, 0), {
              transmission: 0.8,
              thickness: 0.2,
              attenuationColor: [0.3, 0.6, 0.8],
              side: 'double',
            });
          physical.instances = instances;
          const probe = reader(expected);
          probe.options.transparent = true;
          probe.options.opacity = 1;
          colors(
            'native physical tint stencil operation executes once ' + op + back + instances,
            await render(
              `physical-tint-${op}-${back}-${instances}`,
              [physical, probe],
              { back, clear: stored },
              instances ? instancePoints : points,
            ),
            blue,
          );
        }
    for (const back of [false, true]) {
      const physical = writer(
        7,
        {
          depthWrite: true,
          depthCompare: 'greater',
          ...stencil({ compare: 'always', passOp: 'replace', depthFailOp: 'zero' }, 7),
        },
        { transmission: 0.8, thickness: 0.2, side: 'double' },
      );
      const probe = reader(7);
      probe.options.transparent = true;
      probe.options.opacity = 1;
      colors(
        'physical tint preserves strict depth test for its main write',
        await render('physical-strict-depth-' + back, [physical, probe], { back }),
        blue,
      );
    }
    await render('live-bias-start', [{ options: { color: [0, 1, 0] } }, { state: { depthCompare: 'greater' } }]);
    for (const bias of [2048, -2048, 2048]) {
      const state = await page.evaluate(
          (depthBias) => window.renderStateFixture.liveNative(1, { depthCompare: 'greater', depthBias }),
          bias,
        ),
        actual = await read('live-bias-' + bias, state);
      colors('live native bias changes coplanar visibility', actual, bias > 0 ? red : green);
      for (const resource of ['textures', 'samplers', 'buffers'])
        check('live native bias reuses ' + resource, state.allocations[resource], 0);
    }
    const liveDraws = [writer(3), reader(3)];
    await render('live-native-start', liveDraws);
    for (const reference of [4, 3]) {
      const state = await page.evaluate(
          ({ reference }) =>
            window.renderStateFixture.liveNative(1, {
              depthWrite: false,
              depthCompare: 'always',
              stencilFront: { compare: 'equal' },
              stencilBack: { compare: 'equal' },
              stencilWriteMask: 0,
              stencilReference: reference,
            }),
          { reference },
        ),
        actual = await read('live-reference-' + reference, state);
      colors('live dynamic reference affects pixels', actual, reference === 3 ? blue : blank);
      for (const resource of ['textures', 'samplers', 'buffers', 'groups', 'pipelines'])
        check('reference-only update reuses ' + resource, state.allocations[resource], 0);
    }
    const beforeRestore = await render('restore-stencil', [mask, reader(7)], {}, instancePoints),
      restored = await page.evaluate(() => window.renderStateFixture.restore()),
      afterRestore = await read('after-device-restore', restored, instancePoints);
    check('device actually replaced', restored.changedDevice, true);
    check('stencil output restored', afterRestore.image, beforeRestore.image);
    const borrowed = await render(
      'stencil-helper-borrows-supported-target',
      [mask, reader(7)],
      { stencilBuffer: true },
      instancePoints,
    );
    colors('supported stencil target is borrowed', borrowed, (i) => (i === 0 ? blue : blank));
    check('borrowed target allocates no portable stencil attachment', borrowed.state.promotedTextures, 0);
    check('borrowed rendering format', borrowed.state.renderingFormat, 'depth32float-stencil8');
    const portable = await render(
      'portable-stencil-promotion',
      [mask, reader(7)],
      { noStencil: true, stencilBuffer: true },
      instancePoints,
    );
    colors('portable promotion supplies actual stencil masking', portable, (i) => (i === 0 ? blue : blank));
    check('portable test outer target lacks stencil', portable.state.format, 'depth32float');
    check('optional helper promotes actual rendering format', portable.state.renderingFormat, 'depth24plus-stencil8');
    check('portable promotion allocates one depth-stencil texture', portable.state.promotedTextures, 1);
    check('nested target formats restored at end of graph', portable.state.restoredFormat, 'depth32float-stencil8');
    const stable = await page.evaluate((state) => window.renderStateFixture.liveNative(1, state), reader(7).state);
    check('portable attachment reused on unchanged frame', stable.allocations.textures, 0);
    const portableRestored = await page.evaluate(() => window.renderStateFixture.restore()),
      portableImage = await read('portable-after-device-restore', portableRestored, instancePoints);
    check('portable helper actual device replacement', portableRestored.changedDevice, true);
    check('portable helper rebuilds and preserves stencil output', portableImage.image, portable.image);
    check('portable helper remains portable after restore', portableRestored.renderingFormat, 'depth24plus-stencil8');
    const detached = await render('after-portable-helper-dispose', [{}], { noStencil: true });
    colors('helper disposal returns to valid nonstencil target', detached, red);
    check(
      'helper disposal restores original requested rendering format',
      detached.state.renderingFormat,
      'depth32float',
    );
    let unsupported = '';
    try {
      await render('stencil-without-attachment', [reader(1)], { noStencil: true });
    } catch (error) {
      unsupported = String(error);
    }
    check(
      'stencil state without stencil target reports a clear error',
      /stencil.*(?:aspect|target|format)/i.test(unsupported),
      true,
    );
    await page.evaluate(() => window.renderStateFixture.dispose());
    await page.goto(
      `http://127.0.0.1:5219/tests/material-render-state.html?samples=${samples === 1 ? '1' : '4'}&afterUnsupported=1`,
    );
    await page.waitForFunction(() => window.renderStateFixture);
    colors(
      'normal rendering survives isolated unsupported-target check',
      await render('after-unsupported-current', [{}]),
      red,
    );
    if (baseline)
      for (const shading of [undefined, 'basic', 'normal', 'depth', 'distance'])
        for (const doubleSided of [false, true]) {
          const draws = [
            { options: { ...(shading ? { shading } : {}), doubleSided, color: [0.3, 0.6, 0.2], roughness: 0.7 } },
          ];
          await render(`legacy-${shading}-${doubleSided}`, draws, { legacy: true });
          const before = await page.evaluate(() => window.renderStateFixture.digest());
          await render(`current-${shading}-${doubleSided}`, draws);
          check(
            `${shading ?? 'default'} doubleSided=${doubleSided} entire default attachment unchanged`,
            await page.evaluate(() => window.renderStateFixture.digest()),
            before,
          );
        }
  }
  check('page errors', errors, []);
  check('GPU validation and engine errors', await page.evaluate(() => window.renderStateFixture.errors), []);
  assert.deepEqual(report.failures, [], 'Polygon offset/stencil GPU comparisons failed');
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(output + '/gpu.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        hardware: report.hardware?.webgpu,
        checks: report.checks.length,
        captures: report.captures.length,
        failures: report.failures,
        error: report.error,
        report: output + '/gpu.json',
      },
      null,
      2,
    ),
  );
  await browser?.page.evaluate(() => window.renderStateFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
