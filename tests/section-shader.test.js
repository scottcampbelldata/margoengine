import test from 'node:test';
import assert from 'node:assert/strict';

const helpers = await import('../packages/shared/section.js').catch(() => ({}));

test('section clipping reuses the current uniform binding and ignores a removed section', () => {
  assert.equal(typeof helpers.sectionState, 'function');
  const buffer = {},
    context = {
      shader: '@group(0) @binding(4) var<uniform> section:Section;',
      bindings: [{ binding: 4, resource: { buffer } }],
    };
  assert.equal(helpers.sectionState(context)?.buffer, buffer);
  context.bindings = [];
  assert.equal(helpers.sectionState(context), undefined);
});

test('section clipping follows fragment derivatives and covers every fragment return', () => {
  assert.equal(typeof helpers.sectionShader, 'function');
  const source = `fn surface(i:Out)->vec4f {return textureSample(t,s,i.uv);}
@fragment fn fragment(i:Out)->vec4f {let color=surface(i);return color;}
@fragment fn capture(i:Out)->vec4f {let color=surface(i);if(color.a<0.5){return vec4f(0);}return color;}`;
  const code = helpers.sectionShader(source, 0, 2);
  assert.match(code, /@group\(0\) @binding\(2\)/);
  assert.equal(code.match(/dot\(section.planes\[p\].xyz,i.position\)/g)?.length, 3);
  assert.ok(code.indexOf('let color=surface(i);') < code.indexOf('for(var p='));
  assert.ok(code.includes('fn surface(i:Out)->vec4f {return textureSample(t,s,i.uv);}'));
});

test('section clipping evaluates a direct fragment return before discard', () => {
  const code = helpers.sectionShader('@fragment fn transparent(i:Out)->vec4f {return shade(i);}', 0, 2);
  assert.match(code, /let sectionResult=shade\(i\);for\(/);
});

test('a clip-distance mark is applied after another patch glues its code in front with no newline', () => {
  const material = helpers.markClipDistances(
    'struct Out {@builtin(position) clip:vec4f,@location(0) position:vec3f}\n@vertex fn vertex()->Out {var o:Out;return o;}',
    2,
    199,
    'materialClip',
  );
  // Clustered's lighting patch ends its functions with `}` and prepends them as they are (KB-CLIP-HWMARK1).
  for (const code of [material, 'fn light()->f32 {return 1.0;}' + material]) {
    const out = helpers.markedClipDistances(code);
    assert.ok(out.startsWith('enable clip_distances;'), 'the mark is found');
    assert.match(out, /->MargoClipped \{var o:MargoClipped;.*o\.margoClip\[margoP\]=/s);
  }
  assert.equal(helpers.markedClipDistances('fn a() {}'), 'fn a() {}', 'unmarked code is left as it is');
});
