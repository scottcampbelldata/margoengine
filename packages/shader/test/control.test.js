import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  Break,
  ComputePass,
  Continue,
  Fn,
  If,
  Let,
  Loop,
  NodeMaterial,
  NodePass,
  Switch,
  Var,
  While,
  block,
  discard,
  float,
  inputColor,
  int,
  loop,
  select,
  sin,
  storage,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
} from '../dist/index.js';

const snapshot = async (name, text) => {
  const file = fileURLToPath(new URL(`./snapshots/${name}.wgsl`, import.meta.url));
  if (process.env.UPDATE_SNAPSHOTS) return writeFile(file, text);
  assert.equal(text, (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'), name + ' WGSL changed');
};
const count = (text, part) => text.split(part).length - 1;

test('If runs one branch: a statement, not a select of both sides', async () => {
  const pick = block(() => {
    const c = Var(vec3(0));
    If(uv().x.lessThan(0.25), () => c.assign(vec3(1, 0, 0)))
      .ElseIf(uv().x.lessThan(0.75), () => {
        const wave = sin(uv().y);
        c.assign(vec3(wave, wave, 0));
      })
      .Else(() => c.assign(vec3(0, 0, 1)));
    return c;
  });
  const { fragmentCode } = new NodeMaterial({ colorNode: pick });
  await snapshot('material-control', fragmentCode);
  assert.equal(count(fragmentCode, 'select('), 0);
  assert.equal(count(fragmentCode, 'if ('), 2);
  // The expensive side lives inside its branch, so the other pixels never pay for it.
  assert.ok(fragmentCode.indexOf('sin(') > fragmentCode.indexOf('} else {'));
});

test('a loop leaves early with Break, skips with Continue, and one pass carries several Vars', async () => {
  const limit = uniform(40, { type: 'i32', name: 'limit' }),
    out = storage(4, 'u32'),
    pass = new ComputePass(4, (i) => {
      const sum = Var(0, 'u32'),
        steps = Var(0, 'u32');
      Loop(limit, (k) => {
        If(k.mod(2).equal(1), () => Continue());
        If(sum.greaterThan(uint(10)), () => Break());
        sum.addAssign(k.toUint());
        steps.addAssign(1);
      });
      return out.store(i, sum.add(steps));
    });
  await snapshot('compute-control', pass.code);
  assert.match(pass.code, /continue;/);
  assert.match(pass.code, /break;/);
});

test('a Loop range counts up or down and rejects a useless step', () => {
  const body = () =>
    block(() => {
      const s = Var(0);
      Loop({ from: 8, to: 0, step: -2 }, (i) => s.addAssign(i.toFloat()));
      return s;
    });
  assert.match(new NodeMaterial({ roughnessNode: body() }).fragmentCode, /for \(var nd\d+ = 8i; nd\d+ > nd\d+; nd\d+ \+= -2i\)/);
  assert.throws(() => block(() => (Loop({ to: 4, step: 0 }, () => {}), float(0))), /non-zero integer/);
  assert.throws(() => block(() => (Loop({ to: 4, step: 0.5 }, () => {}), float(0))), /non-zero integer/);
});

test('While tests before each pass and re-reads the Var it tests', async () => {
  const value = block(() => {
    const n = Var(64),
      steps = Var(0);
    While(n.greaterThan(1), () => {
      n.divAssign(2);
      steps.addAssign(1);
    });
    return steps;
  });
  const { fragmentCode } = new NodeMaterial({ roughnessNode: value });
  await snapshot('material-while', fragmentCode);
  assert.ok(fragmentCode.indexOf('break;') < fragmentCode.indexOf(' / 2.0'), 'the test comes first');
});

test('Switch has one default, even when none is given, and refuses repeats', async () => {
  const mode = uniform(1, { type: 'u32', name: 'mode' }),
    value = block(() => {
      const c = Var(0);
      Switch(mode)
        .Case(0, () => c.assign(0.25))
        .Case([1, 2], () => c.assign(0.5));
      return c;
    });
  const { fragmentCode } = new NodeMaterial({ roughnessNode: value });
  await snapshot('material-switch', fragmentCode);
  assert.equal(count(fragmentCode, 'default:'), 1);
  assert.match(fragmentCode, /case 1u, 2u:/);
  assert.throws(
    () =>
      block(() => {
        Switch(mode)
          .Case(1, () => {})
          .Case([2, 1], () => {});
        return float(0);
      }),
    /two cases for 1/,
  );
  assert.throws(
    () =>
      block(() => {
        const s = Switch(mode);
        s.Default(() => {});
        s.Default(() => {});
        return float(0);
      }),
    /two Default/,
  );
  assert.throws(() => block(() => (Switch(float(1)), float(0))), /i32 or u32/);
});

// Regression guards for the compiler: a shared expression must not outlive the value it read.
test('an expression read on both sides of an assignment is worked out again', () => {
  const value = block(() => {
    const x = Var(1),
      next = x.add(1),
      first = Let(next.mul(2));
    x.assign(next.mul(3));
    return first.add(next.mul(5));
  });
  const code = new NodeMaterial({ roughnessNode: value }).fragmentCode;
  // `x + 1.0` before the assignment and again after it, never a `let` from before.
  assert.equal(count(code, ' + 1.0'), 2, code);
});

test('an expression that reads no Var stays shared across an assignment', () => {
  const y = sin(uv().x),
    value = block(() => {
      const x = Var(y.mul(2));
      x.assign(x.add(y));
      x.assign(x.add(y));
      return x;
    });
  assert.equal(count(new NodeMaterial({ roughnessNode: value }).fragmentCode, 'sin('), 1);
});

test('a value kept before a loop is not reused inside it when the loop changes what it read', () => {
  const value = block(() => {
    const x = Var(1),
      s = Var(0),
      half = x.mul(0.5);
    s.assign(half.add(half));
    Loop(4, () => {
      s.addAssign(half.add(half));
      x.addAssign(1);
    });
    return s;
  });
  const code = new NodeMaterial({ roughnessNode: value }).fragmentCode,
    body = code.slice(code.indexOf('for ('));
  assert.match(body, /\* 0\.5/, 'the half is worked out on every pass');
});

test('Let keeps its value through assignments', () => {
  const value = block(() => {
    const x = Var(1),
      old = Let(x);
    x.assign(2);
    return old.add(x);
  });
  const code = new NodeMaterial({ roughnessNode: value }).fragmentCode;
  assert.match(code, /let (nd\d+) = (nd\d+);\n\s+\2 = 2\.0;\n\s+let nd\d+ = \1 \+ \2;/, code);
});

test('a value made in a branch cannot leak out of it', () => {
  assert.throws(
    () =>
      new NodeMaterial({
        roughnessNode: block(() => {
          const x = Var(1);
          let inner;
          If(uv().x.lessThan(0.5), () => {
            inner = Let(x.add(1));
          });
          return x.add(inner).add(inner);
        }),
      }),
    /cannot be used outside/,
  );
  assert.throws(
    () =>
      new NodeMaterial({
        roughnessNode: block(() => {
          let inner;
          If(uv().x.lessThan(0.5), () => {
            inner = Var(1);
          });
          return inner.add(1);
        }),
      }),
    /used outside its body/,
  );
});

test('an atomic inside If runs in the branch, once', () => {
  const counter = storage(1, 'u32', { atomic: true }),
    out = storage(8, 'u32'),
    pass = new ComputePass(8, (i) => {
      If(i.mod(2).equal(0), () => {
        const slot = counter.atomicAdd(0, 1);
        out.store(slot, i);
      });
    });
  assert.equal(count(pass.code, 'atomicAdd'), 1);
  assert.ok(pass.code.indexOf('atomicAdd') > pass.code.indexOf('if ('));
  assert.ok(pass.code.lastIndexOf('}\n}') > pass.code.indexOf('] = gid.x;'), 'the store stays in the branch');
});

test('an atomic used after the branch it ran in is refused rather than run twice', () => {
  const counter = storage(1, 'u32', { atomic: true }),
    out = storage(8, 'u32');
  assert.throws(
    () =>
      new ComputePass(8, (i) => {
        let slot;
        If(i.equal(0), () => {
          slot = counter.atomicAdd(0, 1);
          slot.add(slot);
        });
        return out.store(i, slot);
      }),
    /cannot be used outside/,
  );
});

test('stores in a statement body run in order with the statements around them', () => {
  const out = storage(4, 'u32'),
    atomic = storage(4, 'u32', { atomic: true }),
    pass = new ComputePass(4, (i) => {
      Loop(2, (k) => {
        out.store(k.toUint(), i);
        atomic.atomicStore(k.toUint(), i);
      });
    });
  assert.ok(pass.code.indexOf('for (') < pass.code.indexOf('] = gid.x'));
  assert.match(pass.code, /atomicStore\(&ndb\d+\[.*\], gid\.x\);/);
  assert.throws(
    () =>
      new NodeMaterial({
        roughnessNode: block(() => {
          out.store(0, 1);
          return float(0);
        }),
      }),
    /only available in ComputePass/,
  );
});

// Bug: once a body could make statements and so return nothing, a top-level store it forgot to return vanished.
test('a store the body made and did not return still runs, after the returned ones', () => {
  const a = storage(4, 'u32'),
    b = storage(4, 'u32'),
    pass = new ComputePass(4, (i) => {
      a.store(i, 1);
      Loop(2, () => {});
      return b.store(i, 2);
    });
  assert.match(pass.code, /ndb\d+\[gid\.x\] = 2u;\n\s+ndb\d+\[gid\.x\] = 1u;/);
  const once = new ComputePass(4, (i) => {
    const write = a.store(i, 1);
    return write;
  });
  assert.equal(count(once.code, '] = 1u;'), 1);
  assert.doesNotThrow(() => new ComputePass(4, (i) => void a.store(i, 1)));
  assert.throws(() => new ComputePass(4, () => {}), /must make storage/);
});

test('statements compile inside Fn, post effects and vertex nodes', () => {
  const clampLow = Fn(
    (v) =>
      block(() => {
        const r = Var(v);
        If(r.lessThan(0), () => r.assign(0));
        return r;
      }),
    'clampLow',
  );
  const pass = new NodePass(
    block(() => {
      const c = Var(inputColor().rgb);
      If(c.x.greaterThan(0.5), () => c.assign(vec3(1)));
      return c.mul(clampLow(float(2)));
    }),
  );
  assert.match(pass.code(), /fn clampLow/);
  assert.match(pass.code(), /var nd\d+:vec3f = /);
  const material = new NodeMaterial({
    positionNode: block(() => {
      const p = Var(vec3(0, 0, 1));
      p.assignElement(0, 2);
      return p;
    }),
  });
  assert.match(material.vertexCode, /nd\d+\[0i\] = 2\.0;/);
});

test('discard inside a branch cuts only there', () => {
  const material = new NodeMaterial({
    colorNode: block(() => {
      const c = Var(vec3(1));
      If(uv().x.lessThan(0.5), () => c.assign(discard(uv().y.lessThan(0.5), vec3(0))));
      return c;
    }),
  });
  assert.ok(material.fragmentCode.indexOf('discard;') > material.fragmentCode.indexOf('if (' + 'i.uv.x'));
});

test('a block used twice runs once, and in two branches runs once in each', () => {
  const shared = block(() => {
    const s = Var(0);
    Loop(3, () => s.addAssign(1));
    return s;
  });
  assert.equal(count(new NodeMaterial({ roughnessNode: shared, metalnessNode: shared }).fragmentCode, 'for ('), 1);
  const value = block(() => {
    const c = Var(0);
    If(uv().x.lessThan(0.5), () => c.assign(shared)).Else(() => c.assign(shared.mul(2)));
    return c;
  });
  assert.equal(count(new NodeMaterial({ roughnessNode: value }).fragmentCode, 'for ('), 2);
});

test('statements outside a body, and Break or Continue outside a loop, say what to do', () => {
  assert.throws(() => Var(1), /Var runs inside block\(\)/);
  assert.throws(() => If(true, () => {}), /If runs inside block\(\)/);
  assert.throws(() => Loop(1, () => {}), /Loop runs inside block\(\)/);
  assert.throws(() => Break(), /Break runs inside/);
  assert.throws(
    () => block(() => (If(true, () => {}), 1)),
    /must return the node/,
  );
  assert.throws(() => new NodeMaterial({ roughnessNode: block(() => (Break(), float(0))) }), /needs a Loop/);
  assert.throws(() => new NodeMaterial({ roughnessNode: block(() => (Continue(), float(0))) }), /needs a Loop/);
  // A block is a value: it cannot break a loop around it.
  assert.throws(
    () =>
      new NodeMaterial({
        roughnessNode: block(() => {
          const s = Var(0);
          Loop(2, () => s.assign(block(() => (Break(), float(1)))));
          return s;
        }),
      }),
    /needs a Loop/,
  );
  // Continue leaves a Switch only when a loop surrounds it.
  assert.throws(
    () =>
      new NodeMaterial({
        roughnessNode: block(() => {
          Switch(int(0)).Case(0, () => Continue());
          return float(0);
        }),
      }),
    /needs a Loop/,
  );
  assert.throws(() => block(() => (If(vec2(0).lessThan(1), () => {}), float(0))), /If condition must be bool/);
  assert.throws(
    () =>
      block(() => {
        const b = If(true, () => {});
        b.Else(() => {});
        b.ElseIf(true, () => {});
        return float(0);
      }),
    /before Else/,
  );
  assert.throws(() => block(() => (Var(1).assignElement(0, 1), float(0))), /vector or matrix/);
});

test('a fold body can use a block, and its assignments do not leak stale values', () => {
  const value = block(() => {
    const x = Var(1),
      v = x.mul(2),
      a = v.add(v);
    return a.add(
      loop(2, float(0), (i, acc) =>
        block(() => {
          x.addAssign(1);
          return acc.add(v);
        }),
      ),
    );
  });
  assert.doesNotThrow(() => new NodeMaterial({ roughnessNode: value }));
});

test('unused control flow leaves generated code alone', () => {
  const plain = new NodeMaterial({ colorNode: select(uv().x.lessThan(0.5), vec3(1), vec3(0)) });
  assert.doesNotMatch(plain.fragmentCode, /var |for \(|if \(/);
});
