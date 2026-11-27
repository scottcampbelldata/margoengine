// A light of radius 0 in the sized shader (some other light has a `radius`) must shade bit for bit as the plain shader
// (scripts/clustered-sphere-light-gpu-check.js, "radius 0 beside a sized light shades as before"). Written as selects
// over the point light's and the sphere's terms, AMD's compiler fused the point light's arithmetic differently, 13 to
// 16 ulps off (KB-GPU-PRECHECKS1). The sized shader now keeps the plain loop's statements as they are and changes the
// terms only inside `if(rs>0.0)`, so the radius-0 path is the plain shader's own text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clusteredSampling } from '../dist/index.js';

const loop = (code) => code.slice(code.indexOf('for(var j=0u;j<count;j++){'));

test('the sized shader keeps every statement of the plain point light loop, and edits terms only for rs > 0', () => {
  for (const decay of [false, true]) {
    const plain = loop(clusteredSampling(1, undefined, undefined, false, decay, false, {})),
      sized = loop(clusteredSampling(1, undefined, undefined, false, decay, false, { sized: true }));
    const head = plain.slice(0, plain.indexOf('result+=')),
      // Only the four terms the sphere block overwrites become `var`.
      expected = head
        .replace('let nl=', 'var nl=')
        .replace('let d=', 'var d=')
        .replace('let g=', 'var g=')
        .replace('let fresnel=', 'var fresnel=');
    const block = sized.indexOf('let rs=light.size.x;if(rs>0.0){');
    assert.ok(block > 0, 'the sphere terms sit in an if(rs>0.0) block');
    const before = sized.slice(0, block).replace(/\s+$/, ''),
      after = sized.slice(block);
    // Every plain statement appears, in order, before the block; the terms after the fresnel line follow it unchanged.
    const split = expected.indexOf('pow(1-vh,5.0);') + 'pow(1-vh,5.0);'.length;
    assert.equal(before, expected.slice(0, split).replace(/\s+$/, ''));
    const close = after.indexOf('pow(1-svh,5.0);}') + 'pow(1-svh,5.0);}'.length;
    assert.ok(close > 'pow(1-svh,5.0);}'.length, 'the block ends after the sphere fresnel');
    assert.equal(after.slice(close, after.indexOf('result+=')).trim(), expected.slice(split).trim());
    // Inside the block nothing selects between the point and the sphere terms.
    assert.doesNotMatch(after.slice(0, close), /,rs>0\.0\)/);
  }
});
