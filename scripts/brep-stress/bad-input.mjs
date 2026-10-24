import path from 'node:path';
import { isMain, kernel, model, outputRoot, runCases, workerMain } from './common.mjs';

export function cases() {
  const out = [];
  for (const target of [
    'box',
    'cylinder-radius',
    'cylinder-height',
    'sphere',
    'torus-major',
    'torus-minor',
    'fillet',
    'chamfer',
  ])
    for (const value of ['NaN', 'Infinity', '-Infinity', 'zero', 'negative'])
      out.push({ suite: 'G', id: `G-${target}-${value}`, target, value });
  for (const target of [
    'frame-axis',
    'frame-origin',
    'frame-x',
    'raw-frame-axis',
    'raw-frame-origin',
    'raw-frame-x',
    'extrude-vector',
    'profile-normal',
    'profile-point',
    'revolve-axis',
  ])
    for (const value of ['NaN', 'Infinity', 'zero'])
      out.push({ suite: 'G', id: `G-${target}-${value}`, target, value });
  for (const target of [
    'empty',
    'garbage',
    'truncated-header',
    'truncated-data',
    'unterminated-string',
    'missing-ref',
    'bad-number',
    'duplicate-id',
    'bad-edge-ref',
  ])
    out.push({ suite: 'G', id: `G-step-${target}`, target: `step-${target}` });
  return out;
}

function valueOf(name) {
  return { NaN, Infinity, '-Infinity': -Infinity, zero: 0, negative: -0.001 }[name];
}
function profile() {
  return {
    name: 'p',
    normal: [0, 0, 1],
    start: [0, 0, 0],
    segments: [
      { kind: 'line', to: [0.01, 0, 0] },
      { kind: 'line', to: [0.01, 0.01, 0] },
      { kind: 'line', to: [0, 0.01, 0] },
      { kind: 'line', to: [0, 0, 0] },
    ],
  };
}
function invoke(c) {
  const v = valueOf(c.value),
    invalid = [v, 0, 0];
  switch (c.target) {
    case 'box':
      return model.box('bad', [v, 0.01, 0.01]);
    case 'cylinder-radius':
      return model.cylinder('bad', v, 0.01);
    case 'cylinder-height':
      return model.cylinder('bad', 0.001, v);
    case 'sphere':
      return model.sphere('bad', v);
    case 'torus-major':
      return model.torus('bad', v, 0.001);
    case 'torus-minor':
      return model.torus('bad', 0.01, v);
    case 'fillet':
    case 'chamfer': {
      const b = model.box('b', [0.01, 0.01, 0.01]);
      return model[c.target]('bad', b, [b.edges[0].name], v);
    }
    case 'frame-axis':
      return model.frameOf([0, 0, 0], invalid);
    case 'frame-origin':
      return model.frameOf(invalid, [0, 0, 1]);
    case 'frame-x':
      return model.frameOf([0, 0, 0], [0, 0, 1], invalid);
    case 'raw-frame-axis':
    case 'raw-frame-origin':
    case 'raw-frame-x': {
      const f = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
      f[c.target === 'raw-frame-axis' ? 'z' : c.target === 'raw-frame-x' ? 'x' : 'origin'] = invalid;
      return model.box('bad', [0.01, 0.01, 0.01], f);
    }
    case 'extrude-vector':
      return model.extrude('bad', profile(), invalid);
    case 'profile-normal': {
      const p = profile();
      p.normal = invalid;
      return model.extrude('bad', p, [0, 0, 0.01]);
    }
    case 'profile-point': {
      const p = profile();
      p.start = invalid;
      return model.extrude('bad', p, [0, 0, 0.01]);
    }
    case 'revolve-axis':
      return model.revolve('bad', profile(), { origin: [0, 0, 0], direction: invalid });
  }
  const valid = model.bodiesToSTEP([model.box('box', [0.01, 0.01, 0.01])]);
  const inputs = {
    'step-empty': '',
    'step-garbage': 'garbage',
    'step-truncated-header': 'ISO-10303-21; HEADER;',
    'step-truncated-data': valid.slice(0, valid.indexOf('ENDSEC;', valid.indexOf('DATA;'))),
    'step-unterminated-string': valid.replace("'box'", "'box"),
    'step-missing-ref': valid.replace(/MANIFOLD_SOLID_BREP\([^;]+;/, "MANIFOLD_SOLID_BREP('bad',#999999);"),
    'step-bad-number': valid.replace(/CARTESIAN_POINT\('',\([^)]*\)\)/, "CARTESIAN_POINT('',(NaN,0.,0.))"),
    'step-duplicate-id': valid.replace('DATA;', "DATA;\n#1=CARTESIAN_POINT('duplicate',(0.,0.,0.));"),
    'step-bad-edge-ref': valid.replace(/EDGE_CURVE\([^;]+;/, "EDGE_CURVE('bad',#999998,#999999,#999997,.T.);"),
  };
  return model.bodiesFromSTEP(kernel.parseSTEP(inputs[c.target]));
}

export function executeCase(c) {
  const acceptedValid =
    c.value === 'zero' && ['frame-origin', 'frame-x', 'profile-point', 'raw-frame-origin'].includes(c.target);
  try {
    const result = invoke(c);
    if (acceptedValid) return { ...c, status: 'passed', expected: 'valid origin/default x accepted' };
    if (c.target === 'step-bad-edge-ref' && result?.problems?.length && result.bodies.every((b) => !b))
      return {
        ...c,
        status: 'refused',
        signature: 'documented structured import refusal',
        returnedProblems: result.problems,
      };
    return {
      ...c,
      status: 'wrong',
      signature: 'bad-input-accepted',
      expected: 'typed error naming cause',
      actual: result?.constructor?.name,
      returnedProblems: result?.problems,
      returnedBodies: result?.bodies?.length,
    };
  } catch (error) {
    const runtime = /cannot (?:read|set) propert|is not (?:a function|iterable)|maximum call stack|out of memory/i.test(
      error.message,
    );
    const typed = ['MargoError', 'RangeError', 'TypeError'].includes(error.name);
    return {
      ...c,
      status: typed && !runtime ? 'refused' : 'crash',
      signature: `${error.name}: ${error.message}`,
      error: { name: error.name, message: error.message, stack: error.stack },
      expected: 'typed error naming cause',
    };
  }
}

if (isMain(import.meta.url) && !workerMain(executeCase))
  await runCases(cases(), import.meta.url, { output: path.join(outputRoot, 'G.jsonl'), workers: 2 });
