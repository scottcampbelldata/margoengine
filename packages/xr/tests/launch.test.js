import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseARRoute, launchAR, quickLookURL, sceneViewerURL } from '../dist/launch.js';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126';

test('route: WebXR first, then Quick Look, Scene Viewer, none', () => {
  assert.equal(chooseARRoute({ webxr: true, quickLook: true }), 'webxr');
  assert.equal(chooseARRoute({ quickLook: true, userAgent: 'iPhone' }), 'quick-look');
  assert.equal(chooseARRoute({ quickLook: false, userAgent: ANDROID }), 'scene-viewer');
  assert.equal(chooseARRoute({ quickLook: false, userAgent: 'Windows NT 10' }), 'none');
});

test('Quick Look href keeps options in the fragment', () => {
  assert.equal(quickLookURL('https://a.test/m.usdz'), 'https://a.test/m.usdz');
  assert.equal(
    quickLookURL('https://a.test/m.usdz', { allowsContentScaling: false, canonicalWebPageURL: 'https://a.test/p?x=1' }),
    'https://a.test/m.usdz#allowsContentScaling=0&canonicalWebPageURL=https%3A%2F%2Fa.test%2Fp%3Fx%3D1',
  );
  assert.throws(() => quickLookURL(''), RangeError);
});

test('Scene Viewer intent', () => {
  const url = sceneViewerURL('https://a.test/m.glb?v=1', {
    title: 'x'.repeat(80),
    link: 'https://a.test/',
    resizable: false,
    verticalPlacement: true,
    fallbackUrl: 'https://a.test/page',
  });
  assert.match(
    url,
    /^intent:\/\/arvr\.google\.com\/scene-viewer\/1\.0\?file=https%3A%2F%2Fa\.test%2Fm\.glb%3Fv%3D1&mode=ar_preferred&/,
  );
  assert.ok(url.includes('title=' + 'x'.repeat(60) + '&'));
  assert.ok(url.includes('resizable=false') && url.includes('enable_vertical_placement=true'));
  assert.ok(
    url.endsWith(
      'package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;S.browser_fallback_url=https%3A%2F%2Fa.test%2Fpage;end;',
    ),
  );
});

const refused = { code: 'unsupported' };
test('URLs: only http, https and (usdz) blob; others are refused', () => {
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'vbscript:x',
    'file:///etc/passwd',
    '/m.glb',
    ' javascript:alert(1)',
  ]) {
    assert.throws(() => quickLookURL(bad), refused, bad);
    assert.throws(() => sceneViewerURL(bad), refused, bad);
  }
  assert.throws(() => sceneViewerURL('blob:https://a.test/1'), refused);
  assert.equal(quickLookURL('blob:https://a.test/1'), 'blob:https://a.test/1');
  assert.equal(quickLookURL('http://localhost:8080/m.usdz'), 'http://localhost:8080/m.usdz');
  for (const key of ['link', 'sound', 'fallbackUrl'])
    assert.throws(() => sceneViewerURL('https://a.test/m.glb', { [key]: 'javascript:alert(1)' }), refused, key);
  assert.throws(() => quickLookURL('https://a.test/m.usdz', { canonicalWebPageURL: 'data:text/html,x' }), refused);
  assert.throws(() => launchAR({ platform: { quickLook: true }, usdz: 'javascript:alert(1)' }), refused);
});

test('URLs: a relative path resolves against the page base', () => {
  globalThis.document = { baseURI: 'https://a.test/dir/page.html' };
  try {
    assert.equal(quickLookURL('m.usdz'), 'https://a.test/dir/m.usdz');
    assert.ok(sceneViewerURL('/m.glb').includes('file=https%3A%2F%2Fa.test%2Fm.glb'));
  } finally {
    delete globalThis.document;
  }
});

test('Scene Viewer: values cannot break out of their parameter or the intent template', () => {
  const evil = 'https://a.test/m.glb?x=1&mode=3d_only;end;#Intent;package=evil';
  const url = sceneViewerURL(evil, {
    title: 'a&mode=3d_only#Intent;end;',
    fallbackUrl: 'https://a.test/p;end;S.x=y#z',
  });
  // the only raw ';', '#' and '&' are the template's own
  const [head, tail] = url.split('#Intent;');
  assert.equal(url.split('#Intent;').length, 2);
  assert.equal((head.match(/mode=/g) ?? []).length, 1);
  assert.ok(head.includes('file=' + encodeURIComponent(evil)));
  assert.ok(head.includes('title=' + encodeURIComponent('a&mode=3d_only#Intent;end;')));
  assert.equal(tail.split(';').filter((x) => x.startsWith('package=')).length, 1);
  assert.ok(tail.includes('S.browser_fallback_url=' + encodeURIComponent('https://a.test/p;end;S.x=y#z') + ';end;'));
  assert.equal(tail.split(';end;').length, 2);
});

test('Scene Viewer: the mode is one of three', () => {
  for (const mode of ['ar_only', '3d_only;end;', 'x&file=y', ''])
    assert.throws(() => sceneViewerURL('https://a.test/m.glb', { mode }), RangeError, mode);
  for (const mode of ['ar_preferred', '3d_preferred', '3d_only'])
    assert.ok(
      sceneViewerURL('https://a.test/m.glb', { mode }).includes('mode=' + mode + '&') ||
        sceneViewerURL('https://a.test/m.glb', { mode }).includes('mode=' + mode + '#'),
    );
});

test('launchAR clicks a rel=ar link with an image on iOS', () => {
  const links = [];
  globalThis.document = {
    body: { append() {} },
    createElement(tag) {
      const el = {
        tag,
        children: [],
        style: {},
        append(c) {
          this.children.push(c);
        },
        remove() {},
        click() {
          links.push(this);
        },
      };
      return el;
    },
  };
  try {
    const route = launchAR({
      platform: { quickLook: true },
      usdz: 'https://a.test/m.usdz',
      allowsContentScaling: false,
    });
    assert.equal(route, 'quick-look');
    assert.equal(links.length, 1);
    assert.equal(links[0].rel, 'ar');
    assert.equal(links[0].href, 'https://a.test/m.usdz#allowsContentScaling=0');
    assert.equal(links[0].children[0].tag, 'img');
    assert.throws(() => launchAR({ platform: { quickLook: true } }), { code: 'state' });
  } finally {
    delete globalThis.document;
  }
});

test('launchAR sends Android to Scene Viewer and others to the fallback', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.location = { href: 'https://a.test/page' };
  try {
    assert.equal(
      launchAR({ platform: { quickLook: false, userAgent: ANDROID }, glb: 'https://a.test/m.glb' }),
      'scene-viewer',
    );
    assert.ok(globalThis.location.href.startsWith('intent://arvr.google.com/scene-viewer/1.0?file='));
    assert.throws(() => launchAR({ platform: { quickLook: false, userAgent: ANDROID } }), { code: 'state' });
    const seen = [];
    assert.equal(launchAR({ platform: { quickLook: false, userAgent: 'X11' }, fallback: (r) => seen.push(r) }), 'none');
    assert.deepEqual(seen, ['none']);
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had);
    else delete globalThis.location;
  }
});
