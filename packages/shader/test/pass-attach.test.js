// NodePass.attach and ShaderPass.attach run the pass in a PostStack (KB-NODEPASS-ATTACH): the old NodePass.attach was
// engine.use(new NodePass(node)), whose setup always threw 'state' outside a PostStack. Since GAP-POST-ADD1 they join the
// scene's stack when it has one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { PostStack } from '../../post/dist/stack.js';
import { NodePass, inputColor, vec4 } from '../dist/index.js';
import { ShaderPass } from '../dist/glsl-pass.js';

const program = {
  fragmentShader:
    'uniform sampler2D tDiffuse;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = vec4(1.0 - texture2D(tDiffuse, vUv).rgb, 1.0); }',
};
const kinds = [
  ['NodePass', (e, options) => NodePass.attach(e, vec4(inputColor().rgb.oneMinus(), 1), options)],
  ['ShaderPass', (e, options) => ShaderPass.attach(e, program, options)],
];

for (const [kind, attach] of kinds) {
  test(`${kind}.attach runs the pass in a PostStack of its own, which disposing the pass removes`, async (t) => {
    const e = await engine(t);
    const pass = await attach(e, { name: 'attached-pass', kind: 'ldr' });
    assert.equal(pass.name, 'attached-pass');
    assert.equal(pass.kind, 'ldr');
    const stack = e.scene.plugins.get('post:stack');
    assert.ok(stack instanceof PostStack, 'the engine has the stack attach made');
    assert.deepEqual(stack.effects, [pass]);
    assert.equal(e.scene.plugins.get('attached-pass'), pass, 'the stack attached the pass');
    pass.dispose();
    pass.dispose();
    assert.equal(e.hasPlugin('post:stack'), false, 'disposing the pass disposes its stack');
    assert.equal(e.hasPlugin('attached-pass'), false);
    // Disposing the stack instead takes the pass with it.
    const again = await attach(e, { name: 'attached-pass' });
    e.scene.plugins.get('post:stack').dispose();
    assert.equal(e.hasPlugin('attached-pass'), false);
    again.dispose();
    assert.equal(e.scene.plugins.size, 0);
  });

  test(`${kind}.attach joins the scene's PostStack after the last effect of its kind; disposing it leaves the rest`, async (t) => {
    const e = await engine(t);
    const hdr = new NodePass(inputColor(), { name: 'hdr-pass', kind: 'hdr' }),
      ldr = new NodePass(inputColor(), { name: 'ldr-pass', kind: 'ldr' }),
      stack = PostStack.attach(e, [hdr, ldr]);
    const pass = await attach(e, { name: 'joined', kind: 'hdr' });
    assert.equal(e.scene.plugins.get('post:stack'), stack, 'no second stack');
    assert.deepEqual(stack.effects, [hdr, pass, ldr]);
    assert.equal(e.scene.plugins.get('joined'), pass);
    pass.dispose();
    assert.deepEqual(stack.effects, [hdr, ldr], 'the other effects stay');
    assert.equal(e.hasPlugin('joined'), false);
    assert.equal(e.scene.plugins.get('post:stack'), stack, "the caller's stack stays");
    // A repeated name is the stack's TypeError, and the refused pass is disposed.
    await assert.rejects(attach(e, { name: 'hdr-pass' }), TypeError);
    assert.deepEqual(stack.effects, [hdr, ldr]);
    stack.dispose();
  });

  test(`${kind}.attach honours an aborted signal and attaches nothing`, async (t) => {
    const e = await engine(t);
    const done = new AbortController();
    done.abort(new Error('stop now'));
    await assert.rejects(attach(e, { signal: done.signal }), /stop now/);
    const late = new AbortController(),
      pending = attach(e, { name: 'late', signal: late.signal });
    late.abort(new Error('stopped while loading'));
    await assert.rejects(pending, /stopped while loading/);
    assert.equal(e.scene.plugins.size, 0);
  });
}
