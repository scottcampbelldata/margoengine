// MARGO_COMPAT not applicable: the hello-cube template picks WebGPU or the WebGL2 fallback itself.
// The playground page in a real browser (docs/playground.md): a template runs and draws, an error shows its line and its
// error-help link, the frame is sandboxed, forged messages are ignored, and share links open (and bad ones explain).
// After `npm run build:packages`:
//   node scripts/run-with-timeout.mjs --max=5 -- npm run test:playground:browser
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { launchBrowser } from '../../scripts/lib/browser.mjs';
import { server } from '../../scripts/serve-playground.mjs';
import { closeAll } from '../../scripts/support/shutdown.mjs';
import { runMessage, single } from '../../site/playground/share.js';
import { templates } from '../../site/playground/templates.js';
import { decodePNG } from '../support/png.js';

const errorCode = templates.find((t) => t.id === 'error').files[0].code;
// The page is ready when Run is enabled. A goto waits for DOMContentLoaded, not load: load also waits for the sandboxed
// run frame, which Chromium starts in a renderer process of its own (an opaque origin), so a goto to load times a
// process start under whatever else the machine runs. 45 cold loads in fresh contexts, three runs at once, measured
// 0.2 to 0.9 s to load (2026-11-26); one goto in about 15 test runs passed 30 s, waiting for load alone.
const ready = { waitUntil: 'domcontentloaded' };

test('the playground runs templates, reports errors with lines and codes, and opens share links', {
  timeout: 240_000,
}, async () => {
  server.keepAliveTimeout = 0;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const page0 = `http://127.0.0.1:${server.address().port}/site/playground/?packages=/node_modules/`;
  const browser = await launchBrowser({ headless: true });
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    // The first context's first frame creates the browser's first GPU device and compiles the engine's pipelines,
    // which is the slow step of the whole test (a cold shader cache); later steps reuse it. Other contexts keep the
    // default 30 s.
    context.setDefaultTimeout(120_000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // A policy that blocks something the page or the frame needs shows up as a console error.
    page.on('console', (message) => /Content Security Policy/i.test(message.text()) && errors.push(message.text()));
    const response = await page.goto(page0, ready);
    // The page's own policy is strict: its scripts only, nothing inline, no other host to talk to.
    const policy = response.headers()['content-security-policy'];
    assert.match(policy, /script-src 'self';/);
    assert.match(policy, /connect-src 'self';/);
    assert.doesNotMatch(policy, /unsafe-inline|https:/);
    await page.waitForFunction(() => !document.getElementById('run').disabled);

    // A template: it runs at once and draws the lit cube on the dark background.
    await page.selectOption('#template', 'hello-cube');
    await page.locator('#console li', { hasText: 'Rendering with' }).waitFor();
    assert.equal(await page.locator('#stage iframe').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await page.locator('#stage iframe').getAttribute('srcdoc'), null);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    assert.equal(await frame.evaluate(() => origin), 'null', 'the frame has an opaque origin');
    assert.equal(
      await frame.evaluate(() => {
        try {
          return parent.document && 'reached';
        } catch {
          return 'blocked';
        }
      }),
      'blocked',
    );
    await page.waitForTimeout(500);
    const shot = await decodePNG(new Uint8Array(await page.locator('#stage iframe').screenshot()));
    let lit = 0;
    for (let i = 0; i < shot.data.length; i += 4) if (shot.data[i] > 120 && shot.data[i] > shot.data[i + 2] + 40) lit++;
    assert.ok(lit > shot.width * shot.height * 0.005, `the cube is drawn (${lit} warm pixels)`);

    // The API panel lists what the imports export, read from their .d.ts through re-exports
    // (margoengine -> @margoengine/stage -> @margoengine/core), with signatures and doc lines.
    await page.click('#api summary');
    await page.locator('#api-list h3', { hasText: 'margoengine/webgl2-compat/preview' }).waitFor();
    const margo = page.locator('#api-list section').filter({ has: page.locator('h3', { hasText: /^margoengine$/ }) });
    await margo.getByRole('button', { name: 'Insert createStage' }).waitFor();
    assert.match(
      await margo.locator('li', { hasText: 'createStage' }).first().textContent(),
      /function createStage\(target/,
    );
    assert.ok(
      await margo.getByRole('button', { name: 'Insert Engine', exact: true }).count(),
      'core re-exports are followed',
    );
    await page.fill('#api-filter', 'webglRend');
    assert.deepEqual(await page.locator('#api-list h3').allTextContents(), ['margoengine/webgl2-compat/preview']);
    // Ctrl+Space completes a name with one match.
    const before = await page.inputValue('#editor');
    await page.locator('#editor').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\ncreateSta');
    await page.keyboard.press('Control+Space');
    assert.equal(await page.inputValue('#editor'), `${before}\ncreateStage`);
    await page.fill('#editor', before);

    // A message that does not come from the frame is ignored.
    await page.evaluate((channel) => postMessage({ channel, kind: 'error', text: 'forged' }, '*'), 'margo-playground');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#console li', { hasText: 'forged' }).count(), 0);

    // An error: its line in the code, and its MargoError code linked to the error help.
    await page.selectOption('#template', 'error');
    const error = page.locator('#console li.error');
    await error.waitFor();
    assert.match(await error.textContent(), /Mesh disposed.*\(line 9\).*error help: disposed/s);
    assert.match(await error.locator('a').getAttribute('href'), /\/site\/errors\.html#disposed$/);
    assert.match(await page.locator('#status').textContent(), /line 9/);
    await error.getByRole('button', { name: 'line 9' }).click();
    assert.equal(
      await page.evaluate(() => {
        const e = document.getElementById('editor');
        return e.value.slice(e.selectionStart, e.selectionEnd);
      }),
      errorCode.split('\n')[8],
    );

    // Several files: main.js imports ring.js by './ring.js'.
    await page.selectOption('#template', 'modules');
    await page.locator('#console li', { hasText: 'Made 8 balls with ring.js' }).waitFor();
    assert.deepEqual(await page.locator('#tabs [role=tab]').allTextContents(), ['main.js', 'ring.js']);
    // A new tab, imported by main.js, that throws: the error names its file and line, and opens that tab.
    await page.fill('#new-file', 'boom');
    await page.click('#add-file button');
    assert.equal(await page.locator('#tabs [role=tab][aria-selected=true]').textContent(), 'boom.js');
    await page.fill('#editor', "// boom.js\nexport const ok = 1;\nthrow new Error('from boom');\n");
    await page.locator('#tab-0').click();
    const main = await page.inputValue('#editor');
    await page.fill('#editor', `import './boom.js';\n${main}`);
    await page.click('#run');
    const boom = page.locator('#console li.error', { hasText: 'from boom' });
    await boom.waitFor();
    await boom.getByRole('button', { name: 'boom.js line 3' }).click();
    assert.equal(await page.locator('#tabs [role=tab][aria-selected=true]').textContent(), 'boom.js');
    assert.equal(
      await page.evaluate(() => {
        const e = document.getElementById('editor');
        return e.value.slice(e.selectionStart, e.selectionEnd);
      }),
      "throw new Error('from boom');",
    );
    // Removing the tab keeps the project before it as a version.
    await page.getByRole('button', { name: 'Remove boom.js' }).click();
    assert.deepEqual(await page.locator('#tabs [role=tab]').allTextContents(), ['main.js', 'ring.js']);
    await page.selectOption('#template', 'error');
    await page.locator('#console li.error', { hasText: 'Mesh disposed' }).waitFor();

    // The version history holds both runs and restores the earlier one.
    const versions = await page.locator('#versions option').allTextContents();
    assert.ok(
      versions.some((v) => /\(3 files\)$/.test(v)),
      'the three-file project is a version',
    );
    await page.selectOption('#versions', String(versions.findIndex((v) => /\(3 files\)$/.test(v))));
    await page.click('#restore');
    assert.deepEqual(await page.locator('#tabs [role=tab]').allTextContents(), ['main.js', 'ring.js', 'boom.js']);
    await page.selectOption('#template', 'error');
    await error.waitFor();

    // Share: the link carries the code.
    await page.click('#share');
    await page.waitForFunction(() => location.hash.startsWith('#code='));
    const link = page.url();
    const other = await context.browser().newContext();
    try {
      const shared = await other.newPage();
      const saved = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('margo-playground:v1') ?? 'null'));
      // Someone with code of their own...
      await shared.goto(page0, ready);
      await shared.waitForFunction(() => !document.getElementById('run').disabled);
      const own = '// My own scene\nconsole.log("mine");\n';
      await shared.fill('#editor', own);
      await shared.waitForFunction(
        (own) => JSON.parse(localStorage.getItem('margo-playground:v1')).current?.[0]?.code === own,
        own,
      );
      // ...opens the link: the shared code loads and runs, but their saved code stays as it was.
      const visit = async () => {
        await shared.goto('about:blank');
        await shared.goto(link, ready);
        await shared.locator('#console li.error').waitFor();
      };
      await visit();
      assert.equal(await shared.inputValue('#editor'), errorCode);
      assert.equal(await shared.locator('#shared').isVisible(), true);
      assert.match(await shared.locator('#shared').textContent(), /Shared code loaded/);
      assert.deepEqual((await saved(shared)).current, single(own), 'opening a link does not replace the saved code');
      // Back to my code: their code returns, nothing of the link is kept.
      await shared.click('#back');
      assert.equal(await shared.inputValue('#editor'), own);
      assert.equal(await shared.locator('#shared').isVisible(), false);
      assert.deepEqual((await saved(shared)).current, single(own));
      // Running the shared code makes it theirs; their own code is kept as a version.
      await visit();
      assert.deepEqual((await saved(shared)).current, single(own));
      await shared.click('#run');
      await shared.locator('#console li.error').waitFor();
      const after = await saved(shared);
      assert.deepEqual(after.current, single(errorCode));
      assert.ok(
        after.history.some((s) => s.files[0].code === own),
        'their own code is a version',
      );
      assert.equal(await shared.locator('#shared').isVisible(), false);
      // A damaged link says so and changes nothing.
      await shared.goto('about:blank');
      await shared.goto(`${page0}#code=@@not-a-link`, ready);
      await shared.waitForFunction(() => /damaged/.test(document.getElementById('status').textContent));
      assert.equal(await shared.locator('#status').getAttribute('role'), 'alert');
      assert.equal(await shared.inputValue('#editor'), errorCode);
      assert.deepEqual((await saved(shared)).current, single(errorCode));
    } finally {
      await other.close();
    }
    // The run frame on its own: opened at the top level it is still sandboxed (by its header), posts nothing and runs
    // nothing, even when a run message comes from its own window (where parent === window).
    const port = server.address().port;
    const loner = await context.newPage();
    await loner.goto(`http://127.0.0.1:${port}/site/playground/frame/`, ready);
    assert.equal(await loner.evaluate(() => self.origin), 'null', 'sandboxed when opened directly');
    const ranAlone = await loner.evaluate(
      async (message) => {
        postMessage(message, '*');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { title: document.title, maps: document.querySelectorAll('script[type=importmap]').length };
      },
      runMessage(single("document.title = 'ran';"), `http://127.0.0.1:${port}/node_modules/`),
    );
    assert.deepEqual(ranAlone, { title: 'Margo Engine playground', maps: 0 });
    await loner.close();

    // Framed by a test page to try the frame's own checks, as on a host that ignores _headers: the page and a copy of
    // the frame are written under test-results/, which the server sends with no site headers. A frame copy from the
    // page's origin answers; one from another origin (localhost against 127.0.0.1) stays silent; and a message from a
    // sibling frame instead of the parent runs nothing.
    const probeDir = new URL('../../test-results/playground-probe/', import.meta.url);
    await mkdir(new URL('frame/', probeDir), { recursive: true });
    await copyFile(
      new URL('../../site/playground/frame/index.html', import.meta.url),
      new URL('frame/index.html', probeDir),
    );
    await writeFile(new URL('index.html', probeDir), '<!doctype html><title>probe</title><body></body>');
    const probe = await context.newPage();
    await probe.goto(`http://127.0.0.1:${port}/test-results/playground-probe/`);
    const tryFrame = (host, from) =>
      probe.evaluate(
        async ({ src, message, from }) => {
          const frame = Object.assign(document.createElement('iframe'), { src });
          frame.setAttribute('sandbox', 'allow-scripts');
          const heard = [];
          addEventListener(
            'message',
            (e) =>
              e.source === frame.contentWindow &&
              e.data.kind !== 'api' && // the API list arrives beside the run, in no fixed order
              heard.push(e.data.kind === 'error' ? `error: ${e.data.text}` : e.data.kind),
          );
          document.body.append(frame);
          await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (from === 'parent') frame.contentWindow.postMessage(message, '*');
          else {
            // A sibling frame posts the run message to the run frame.
            const sibling = document.createElement('iframe');
            sibling.setAttribute('sandbox', 'allow-scripts');
            sibling.srcdoc = `<script>parent.frames[0].postMessage(${JSON.stringify(message)}, '*')</script>`;
            document.body.append(sibling);
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          frame.remove();
          document.querySelectorAll('iframe').forEach((f) => f.remove());
          return heard;
        },
        {
          src: `http://${host}:${port}/test-results/playground-probe/frame/`,
          message: runMessage(single("console.log('ran');"), `http://127.0.0.1:${port}/node_modules/`),
          from,
        },
      );
    assert.deepEqual(await tryFrame('127.0.0.1', 'parent'), ['ready', 'log', 'done'], 'the control runs');
    assert.deepEqual(await tryFrame('localhost', 'parent'), [], 'a parent of another origin gets nothing');
    assert.deepEqual(await tryFrame('127.0.0.1', 'sibling'), ['ready'], 'a message from a sibling runs nothing');
    await probe.close();

    // Page errors include the frame's: the only ones are the error template's own, on purpose.
    assert.deepEqual(
      errors.filter((message) => !/^Mesh disposed/.test(message)),
      [],
    );
  } finally {
    await closeAll({ context, browser, servers: [server] });
  }
});
