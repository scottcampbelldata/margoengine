// Real-GPU check of @margoengine/humans (WebGPU, or the WebGL2 compatibility layer with MARGO_COMPAT=1): addPerson
// draws the same frame, pixel for pixel, as the hand-wiring it replaces (skin by material name, Animation skinning
// about centres of rotation, the model in the shadows), and its Animator seeks as a pure function of time and cross-fades
// between clips. Run from the repository root after building packages:
//   node packages/humans/test/person-still.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const port = 5321,
  context = await openBrowser({ startPath: '/packages/humans/test/person-still.html', port }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
console.log('device', context.hardware?.compat ? 'webgl2-compat layer' : 'webgpu');
try {
  await page.goto(`http://127.0.0.1:${port}/packages/humans/test/person-still.html`);
  await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
  const hand = await page.evaluate(() => window.check.frame(false)),
    person = await page.evaluate(() => window.check.frame(true));
  assert.deepEqual(hand.errors, []);
  assert.deepEqual(person.errors, []);
  let differ = 0;
  for (let i = 0; i < Math.max(hand.bytes.length, person.bytes.length); i++)
    if (hand.bytes[i] !== person.bytes[i]) differ++;
  console.log('frame:', hand.bytes.length, 'PNG bytes,', differ, 'differ from the hand-wired frame');
  assert.equal(differ, 0, 'addPerson draws the hand-wired frame exactly');
  // The figure is in the frame: not just the #30333a background.
  const image = await decodePNG(new Uint8Array(person.bytes)),
    channels = image.data.length / (image.width * image.height);
  let figure = 0;
  for (let i = 0; i < image.data.length; i += channels)
    if (Math.abs(image.data[i] - 0x30) + Math.abs(image.data[i + 1] - 0x33) + Math.abs(image.data[i + 2] - 0x3a) > 30)
      figure++;
  console.log('figure covers', ((100 * figure) / (image.width * image.height)).toFixed(1), 'percent of the frame');
  assert.ok(figure > image.width * image.height * 0.02, 'the figure is drawn');
  // Under an overcast sky the person is lit by the sky of its scene: diffuse light and reflections blurred by each
  // material's roughness, so a rougher skin reads differently. A model left out of the sky has only the flat built-in
  // ambient, which reads no roughness: the two roughnesses then draw the same frame (the round 5 Wilbur frames).
  const sky = {};
  for (const [key, rough, option] of [
    ['smooth', 0.3],
    ['rough', 0.8],
    ['smoothOff', 0.3, false],
    ['roughOff', 0.8, false],
  ])
    sky[key] = await page.evaluate(([r, o]) => window.check.sky(r, o), [rough, option]);
  for (const v of Object.values(sky)) assert.deepEqual(v.errors, []);
  const change = (a, b) => {
    let sum = 0,
      n = 0;
    for (let i = 0; i < a.length; i += 4)
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
        n++;
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      }
    return { pixels: n, mean: n ? sum / n / 3 : 0 };
  };
  const joined = change(sky.smooth.pixels, sky.rough.pixels),
    left = change(sky.smoothOff.pixels, sky.roughOff.pixels);
  console.log(
    'overcast sky, skin roughness 0.3 to 0.8: lit by the sky',
    JSON.stringify(joined),
    '; left out',
    JSON.stringify(left),
  );
  assert.deepEqual(
    [sky.smooth.joined, sky.smooth.left],
    [true, false],
    "addPerson joins the scene's sky, dispose leaves it",
  );
  assert.equal(sky.smoothOff.joined, false, 'sky: false leaves the sky out');
  assert.ok(
    joined.pixels > left.pixels * 2 && joined.pixels > 2000,
    'the sky reflection on the skin reads its roughness',
  );
  // KB-GLTF-SCENESKY1: the person's outfit (a second glTF on the right) and a prop (Lantern, on the left) given no
  // sky.add are lit by the scene's sky all the same, so their roughness reads under the overcast sky as the skin's
  // does. Left out (model.sceneSky false) they had the flat built-in ambient: the two roughnesses drew alike.
  const dressed = {};
  for (const [key, rough, off] of [
    ['smooth', 0.3, false],
    ['rough', 0.8, false],
    ['smoothOff', 0.3, true],
    ['roughOff', 0.8, true],
  ])
    dressed[key] = await page.evaluate(([r, o]) => window.check.outfit(r, o), [rough, off]);
  for (const v of Object.values(dressed)) assert.deepEqual(v.errors, []);
  const third = (a, b, x0, x1) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      const x = (i / 4) % 480;
      if (x >= x0 && x < x1 && (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2])) n++;
    }
    return n;
  };
  const prop = {
      lit: third(dressed.smooth.pixels, dressed.rough.pixels, 0, 160),
      off: third(dressed.smoothOff.pixels, dressed.roughOff.pixels, 0, 160),
    },
    outfit = {
      lit: third(dressed.smooth.pixels, dressed.rough.pixels, 320, 480),
      off: third(dressed.smoothOff.pixels, dressed.roughOff.pixels, 320, 480),
    };
  console.log(
    'overcast sky, roughness 0.3 to 0.8, pixels changed: prop',
    JSON.stringify(prop),
    'outfit',
    JSON.stringify(outfit),
  );
  assert.deepEqual(
    dressed.smooth.joined,
    { outfit: true, prop: true },
    "the outfit and the prop join their scene's sky by themselves",
  );
  assert.equal(dressed.smooth.left, false, 'a disposed model leaves the sky');
  assert.deepEqual(dressed.smoothOff.joined, { outfit: false, prop: false }, 'sceneSky false leaves them out');
  for (const [name, v] of [
    ['prop', prop],
    ['outfit', outfit],
  ])
    assert.ok(v.lit > v.off * 2 && v.lit > 1000, `the sky reflection on the ${name} reads its roughness`);
  // Skin colour in sun: the person's skin against the same figure drawn by the plain PBR shader under the same noon sky
  // (blue sky fill and warm sun), over the figure's pixels, in linear light. Left out of the sky, the person had a warm
  // sun and a grey built-in ambient, so it read orange beside everything the sky lit (Wilbur's sunny round 5 forehead:
  // blue / green 0.50 against its texture's 0.67).
  const tone = {};
  for (const mode of ['empty', 'plain', 'person', 'off']) {
    tone[mode] = await page.evaluate((m) => window.check.tone(m), mode);
    assert.deepEqual(tone[mode].errors, []);
  }
  const linear = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const mask = [];
  for (let i = 0; i < tone.empty.pixels.length; i += 4)
    if (
      Math.abs(tone.plain.pixels[i] - tone.empty.pixels[i]) +
        Math.abs(tone.plain.pixels[i + 1] - tone.empty.pixels[i + 1]) +
        Math.abs(tone.plain.pixels[i + 2] - tone.empty.pixels[i + 2]) >
      24
    )
      mask.push(i);
  const ratios = (px) => {
    const s = [0, 0, 0];
    for (const i of mask) for (let k = 0; k < 3; k++) s[k] += linear(px[i + k]);
    return { rg: s[0] / s[1], bg: s[2] / s[1] };
  };
  const plain = ratios(tone.plain.pixels),
    skinned = ratios(tone.person.pixels),
    off = ratios(tone.off.pixels);
  console.log(
    'noon sky, figure',
    mask.length,
    'px, r/g and b/g: plain PBR',
    JSON.stringify(plain),
    'skin',
    JSON.stringify(skinned),
    'skin left out of the sky',
    JSON.stringify(off),
  );
  assert.ok(mask.length > 5000, 'the figure is drawn');
  assert.ok(
    Math.abs(skinned.bg / plain.bg - 1) < 0.05 && Math.abs(skinned.rg / plain.rg - 1) < 0.05,
    "the skin keeps the colour the scene's light gives its albedo",
  );
  assert.ok(off.bg < plain.bg * 0.9, 'left out of the sky, the same skin reads orange: the check tells the two apart');
  const b = await page.evaluate(() => window.check.behaviour());
  console.log('behaviour', JSON.stringify(b));
  assert.deepEqual(b.errors, []);
  assert.deepEqual(b.clips, ['stand', 'wave']);
  assert.equal(b.state, 'stand', 'the first clip by default');
  assert.equal(b.materials, true, 'no material is named for a look');
  assert.ok(Math.abs(b.stand - 0.1) < 1e-5, `stand seeked to 0.5 s: ${b.stand}`);
  assert.equal(b.time, 0.5, 'play starts the clip at its at time');
  assert.ok(
    Math.abs(b.mid - 0.42) < 1e-5,
    `halfway through the fade, half stand at 0.7 s and half wave at 0.7 s: ${b.mid}`,
  );
  assert.ok(Math.abs(b.end - 0.95) < 1e-5, `the fade ends on wave at 0.95 s: ${b.end}`);
  for (const [at, angle] of b.seeks) assert.ok(Math.abs(angle - at) < 1e-5, `wave seeked to ${at}: ${angle}`);
  assert.equal(b.unknown, 'RangeError');
  assert.equal(b.after, false, 'disposed, the Animation is off the engine');
  const shells = await page.evaluate(() => window.check.shells());
  assert.deepEqual(shells.errors, []);
  assert.deepEqual(shells.plain, [1, 1, 0], 'a plain tear line shell is cut away whole');
  assert.deepEqual(shells.drawn, [2, 0.5, 1], "the CC reader's tear line keeps its BLEND strip");
  assert.deepEqual(shells.restored, [2, 0.5, 1], 'dispose puts the shell back');
  assert.equal(shells.cards, true, 'the Std_Eyelash card gets hairCards by default');
  assert.equal(shells.noCards, true, 'cards: false leaves the lash card plain');
  const h = await page.evaluate(() => window.check.hair());
  console.log('hair', JSON.stringify(h));
  assert.deepEqual([...h.axis.errors, ...h.uv.errors], []);
  assert.deepEqual([h.axis.hair, h.uv.hair], [true, true], 'addPerson puts strand hair on the hair material');
  // KB-MODELFEAT-JOINTS1: a mesh-axis direction follows the joint carrying the hair, as the skinning moves its vertices.
  assert.equal(h.axis.binds, true, 'a mesh-axis hair direction follows its joint');
  assert.equal(h.uv.binds, false, "a 'v' hair direction reads the skinned tangents and needs no follow");
  assert.deepEqual(pageErrors, []);
  console.log('person still check passed');
} finally {
  await context.close();
}
