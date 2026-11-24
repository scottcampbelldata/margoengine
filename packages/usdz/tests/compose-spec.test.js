// The rules of the Composition chapter of the AOUSD USD Core Specification v1.1.0, one test each, on stages written here.
// Every stage marks its opinions with `#name`: each marked spec authors one attribute per pair of opinions, so the composed
// values show the whole strength order, not only the strongest opinion. The stages are ours; the rules are the specification's.
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

/** Replaces each `#name` with the attributes that show `order`: for each pair, the stronger opinion's index wins. */
function marked(text, order) {
  return text.replace(/#([a-zA-Z]\w*)(?!\w| 1\.0)/g, (whole, name) => {
    if (name === 'usda') return whole;
    const at = order.indexOf(name);
    assert.notEqual(at, -1, `${name} is not in the expected order`);
    const lines = [];
    for (let i = 0; i < order.length; i++)
      if (i !== at) lines.push(`custom int p${Math.min(i, at)}_${Math.max(i, at)} = ${at}`);
    return lines.join('\n');
  });
}
async function strongestFirst(layers, path, order) {
  const read = (id) => (id in layers ? new TextEncoder().encode(marked(layers[id], order)) : undefined);
  const { specs } = await composeUSDFiles('root.usda', read);
  for (let i = 0; i < order.length; i++)
    for (let j = i + 1; j < order.length; j++)
      assert.equal(specs[`${path}.p${i}_${j}`]?.fields.default, i, `${order[i]} is stronger than ${order[j]}`);
}

test('Inherits: an arc in a referenced stack is implied in the stack that brought it, and the class chain with it', async () => {
  await strongestFirst(
    {
      'root.usda': `#usda 1.0
def "Root" (references = @./ref.usda@</Ref>) {
#root
}
class "One" {
#rootOne
}
class "Two" {
#rootTwo
}`,
      'ref.usda': `#usda 1.0
class "One" (inherits = </Two>) {
#refOne
}
class "Two" {
#refTwo
}
def "Ref" (inherits = </One>) {
#ref
}`,
    },
    '/Root',
    ['root', 'rootOne', 'rootTwo', 'ref', 'refOne', 'refTwo'],
  );
});

test('Strength Ordering: an authored arc beats an implied one of equal depth, whatever their places in their lists', async () => {
  await strongestFirst(
    {
      'root.usda': `#usda 1.0
class "Skip" {
}
class "Authored" {
#authored
}
class "Implied" {
#implied
}
def "Root" (
  inherits = [</Skip>, </Authored>]
  references = @./ref.usda@</Ref>
) {
#root
}`,
      'ref.usda': `#usda 1.0
class "Implied" {
#refImplied
}
def "Ref" (inherits = </Implied>) {
#ref
}`,
    },
    '/Root',
    ['root', 'authored', 'implied', 'ref', 'refImplied'],
  );
});

test('an internal reference brings in no new stack: its class stays weaker than the referenced prim, as in OpenUSD', async () => {
  await strongestFirst(
    {
      'root.usda': `#usda 1.0
class "Class" {
#cls
}
def "Source" (inherits = </Class>) {
#source
}
def "Root" (references = </Source>) {
#root
}`,
    },
    '/Root',
    ['root', 'source', 'cls'],
  );
});

test('an internal reference still maps a class under the referenced prim to the referencing prim', async () => {
  await strongestFirst(
    {
      'root.usda': `#usda 1.0
def "Source" {
  class "Class" {
#sourceClass
  }
  def "Kid" (inherits = </Source/Class>) {
#sourceKid
  }
}
def "Root" (references = </Source>) {
  class "Class" {
#rootClass
  }
  over "Kid" {
#rootKid
  }
}`,
    },
    '/Root/Kid',
    ['rootKid', 'rootClass', 'sourceKid', 'sourceClass'],
  );
});

test('an arc behind an internal reference is still implied in the stack above it', async () => {
  await strongestFirst(
    {
      'root.usda': `#usda 1.0
class "Class" {
#rootClass
}
def "Root" (references = @./ref.usda@</Top>) {
#root
}`,
      'ref.usda': `#usda 1.0
class "Class" {
#refClass
}
def "Inner" (inherits = </Class>) {
#inner
}
def "Top" (references = </Inner>) {
#top
}`,
    },
    '/Root',
    ['root', 'rootClass', 'top', 'inner', 'refClass'],
  );
});

test('Specializes: every opinion of a prim beats every opinion of what it specializes, implied ones included', async () => {
  await strongestFirst(
    {
      'root.usda': `#usda 1.0
def "Root" (references = @./ref.usda@</Ref>) {
#root
}
class "One" {
#rootOne
}
class "Two" {
#rootTwo
}`,
      'ref.usda': `#usda 1.0
class "One" (specializes = </Two>) {
#refOne
}
class "Two" {
#refTwo
}
def "Ref" (specializes = </One>) {
#ref
}`,
    },
    '/Root',
    ['root', 'ref', 'rootOne', 'refOne', 'rootTwo', 'refTwo'],
  );
});

test('Specializes of equal depth rank by the arc that brought them: through a reference beats authored on the prim', async () => {
  await strongestFirst(
    {
      'root.usda': `#usda 1.0
class "Own" {
#own
}
class "Far" {
#rootFar
}
def "Root" (
  specializes = </Own>
  references = @./ref.usda@</Ref>
) {
#root
}`,
      'ref.usda': `#usda 1.0
class "Far" {
#refFar
}
def "Ref" (specializes = </Far>) {
#ref
}`,
    },
    '/Root',
    ['root', 'ref', 'rootFar', 'refFar', 'own'],
  );
});

test('a class met through an authored and an implied specializes arc keeps the place of the authored arc', async () => {
  await strongestFirst(
    {
      'root.usda': `#usda 1.0
class "Base" {
#rootBase
}
def "Root" (
  specializes = </Base>
  references = @./ref.usda@</Ref>
) {
#root
}`,
      'ref.usda': `#usda 1.0
class "Base" {
#refBase
}
def "Ref" (specializes = </Base>) {
#ref
}`,
    },
    '/Root',
    ['root', 'ref', 'refBase', 'rootBase'],
  );
});

const timed = (head, reference = '@./ref.usda@</Ref>') => ({
  'root.usda': `#usda 1.0
(
${head}
)
def "Root" (references = ${reference}) {
}`,
  'ref.usda': `#usda 1.0
(
    timeCodesPerSecond = 24
)
def "Ref" {
    double v.timeSamples = { 10: 1 }
}`,
  'sub.usda': `#usda 1.0
(
    timeCodesPerSecond = 24
)
over "Root" {
    double w.timeSamples = { 10: 1 }
}`,
});
const compose = (layers, issues = []) =>
  composeUSDFiles('root.usda', (id) => (id in layers ? new TextEncoder().encode(layers[id]) : undefined), { issues });

test('Sublayer and Reference Time Offsets: a scale at or below 0 is a composition error and counts as the default', async () => {
  for (const scale of ['0', '-2']) {
    const stage = await compose(timed('timeCodesPerSecond = 24', `@./ref.usda@</Ref> (offset = 5; scale = ${scale})`));
    assert.deepEqual(stage.specs['/Root.v'].fields.timeSamples.times, [10]);
    assert.ok(stage.issues.some((i) => i.code === 'invalid-offset'));
    const sub = await compose(timed(`timeCodesPerSecond = 24\n    subLayers = [@./sub.usda@ (offset = 5; scale = ${scale})]`));
    assert.deepEqual(sub.specs['/Root.w'].fields.timeSamples.times, [10]);
    assert.ok(sub.issues.some((i) => i.code === 'invalid-offset'));
  }
});

test('Time Codes Per Second: a rate of 0 or below makes that error too, and the stage still opens', async () => {
  for (const rate of ['0', '-1']) {
    const stage = await compose(timed(`timeCodesPerSecond = ${rate}\n    subLayers = [@./sub.usda@]`));
    assert.deepEqual(stage.specs['/Root.v'].fields.timeSamples.times, [10]);
    assert.deepEqual(stage.specs['/Root.w'].fields.timeSamples.times, [10]);
    assert.ok(stage.issues.some((i) => i.code === 'invalid-offset'));
  }
  const fine = await compose(timed('timeCodesPerSecond = 48'));
  assert.deepEqual(fine.specs['/Root.v'].fields.timeSamples.times, [20]);
  assert.deepEqual(fine.issues, []);
});
