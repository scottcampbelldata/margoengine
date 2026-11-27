// MARGO_COMPAT not applicable: the pages send WebRTC audio and video and make no GPU calls.
// Real media proof: two real Chromium pages, then a third that joins late, find each other through a SignalServer, and
// MediaSession sends a fake microphone and a captured tab over their PeerMesh links. Chromium's fake capture device
// plays a 440 Hz tone from a file (--use-fake-device-for-media-stream with --use-file-for-fake-audio-capture), so a
// listener's level meter must hear it. `npm run test:browser --workspace @margoengine/netcode`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';
import { launchBrowser } from '../../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../../scripts/support/shutdown.mjs';
import { listenWebSocket } from '../../dist/node.js';
import { SignalServer } from '../../dist/signal.js';

const limit = setTimeout(() => {
  console.error('media proof timed out');
  process.exit(1); // process.exit: the hard limit; media that never arrives would hold the process for ever
}, 90_000);

/** One second of a 440 Hz sine at half scale, 48 kHz mono 16-bit PCM: an RMS of 0.354, far above `speakingOn`. */
function tone() {
  const rate = 48_000,
    wav = Buffer.alloc(44 + rate * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + rate * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(rate * 2, 40);
  for (let i = 0; i < rate; i++)
    wav.writeInt16LE(Math.round(16_383 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return wav;
}

const dist = join(dirname(fileURLToPath(import.meta.url)), '../../dist'),
  folder = mkdtempSync(join(tmpdir(), 'media-proof-'));
const wav = join(folder, 'tone.wav');
writeFileSync(wav, tone());
await build({
  input: { signal: join(dist, 'signal.js'), websocket: join(dist, 'websocket.js'), media: join(dist, 'media.js') },
  output: { dir: folder, format: 'esm', entryFileNames: '[name].js', chunkFileNames: '[name].js' },
  logLevel: 'silent',
});
const web = createServer((request, response) => {
  if (request.url.endsWith('.js')) {
    response.setHeader('content-type', 'text/javascript');
    return response.end(readFileSync(join(folder, request.url.slice(1))));
  }
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>Margo media proof</title>');
});
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));

const signals = new SignalServer(),
  listener = await listenWebSocket({ port: 0, host: '127.0.0.1', origins: '*' });
listener.onconnection = (connection) => signals.accept(connection);

const browser = await launchBrowser({
  headless: true,
  needs: 'dom',
  args: [
    // Both pages share this machine; see signal.mjs.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    '--auto-accept-this-tab-capture',
    // The strict policy: a page the user never touched starts its AudioContext suspended.
    '--autoplay-policy=document-user-activation-required',
  ],
});
try {
  const url = `ws://127.0.0.1:${listener.port}`;
  /** A page in the room with a MediaSession; `window.until(test)` polls until `test()` holds or 15 s pass. */
  async function join_() {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${web.address().port}/`);
    const id = await page.evaluate(async (url) => {
      const { PeerMesh, SignalClient } = await import('/signal.js'),
        { openWebSocket } = await import('/websocket.js'),
        { MediaSession } = await import('/media.js'),
        room = await SignalClient.join(await openWebSocket(url), 'media');
      window.errors = [];
      window.events = [];
      const mesh = new PeerMesh(room, { onerror: (_peer, error) => window.errors.push(String(error)) });
      const media = new MediaSession(mesh, {
        // The tone is steady: noise suppression would take it for noise, and gain control would move its level.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        pollMs: 20,
      });
      media.addEventListener('error', (e) => window.errors.push(String(e.detail.error)));
      for (const type of ['speaking', 'remote'])
        media.addEventListener(type, (e) =>
          window.events.push({
            type,
            peer: e.detail.peer,
            kind: e.detail.kind,
            on: e.detail.speaking ?? e.detail.active,
          }),
        );
      window.media = media;
      window.until = async (test) => {
        const end = performance.now() + 15_000;
        while (performance.now() < end) {
          if (await test()) return true;
          // fixed-wait: one poll; the loop ends as soon as the test holds
          await new Promise((r) => setTimeout(r, 20));
        }
        return false;
      };
      return room.id;
    }, url);
    return { page, id };
  }
  const wait = async (who, what, test, arg) => {
    const ok = await who.page.evaluate(
      ([source, arg]) => window.until(() => new Function('arg', `return (${source})(arg)`)(arg)),
      [test.toString(), arg],
    );
    const state = ok
      ? ''
      : await who.page.evaluate(() =>
          JSON.stringify({
            errors: window.errors,
            events: window.events.slice(-12),
            remotes: [...window.media.remotes.values()].map((r) => ({
              peer: r.peer,
              voice: !!r.voice,
              screen: !!r.screen,
              speaking: r.speaking,
            })),
          }),
        );
    assert.ok(ok, `${what}; page state ${state}`);
  };

  const a = await join_(),
    b = await join_();

  // Voice: B receives A's microphone and its meter hears the tone; A's own meter hears it too.
  await a.page.evaluate(() => window.media.startVoice());
  await wait(b, "B receives A's voice", (id) => !!window.media.remotes.get(id)?.voice, a.id);
  await wait(b, 'B hears A speaking', (id) => window.media.remotes.get(id)?.speaking === true, a.id);
  await wait(a, 'A hears itself speaking', () => window.events.some((e) => e.peer === 'self' && e.on));

  // Muting sends silence to others; unmuting brings the tone back.
  await a.page.evaluate(() => window.media.setMuted(true));
  await wait(b, 'B hears A stop when A mutes', (id) => window.media.remotes.get(id)?.speaking === false, a.id);
  await a.page.evaluate(() => window.media.setMuted(false));
  await wait(b, 'B hears A again after unmuting', (id) => window.media.remotes.get(id)?.speaking === true, a.id);
  await a.page.evaluate(() => window.media.setPushToTalk(true));
  await wait(b, 'B hears A stop with push-to-talk up', (id) => window.media.remotes.get(id)?.speaking === false, a.id);
  await a.page.evaluate(() => window.media.talk(true));
  await wait(b, 'B hears A with the talk key down', (id) => window.media.remotes.get(id)?.speaking === true, a.id);
  await a.page.evaluate(() => window.media.setPushToTalk(false));
  // A listener's own mute silences playback and leaves the speaking light on.
  await b.page.evaluate((id) => window.media.mutePeer(id, true), a.id);
  await wait(
    b,
    'A still shows speaking while B has muted it',
    (id) => window.media.remotes.get(id)?.speaking === true,
    a.id,
  );

  // Screen share beside the voice: B gets live video frames on the screen stream and keeps the voice.
  await a.page.bringToFront();
  await a.page.evaluate(() =>
    window.media.startScreenShare({ constraints: { video: true, audio: false, preferCurrentTab: true } }),
  );
  await wait(b, "B receives A's screen", (id) => !!window.media.remotes.get(id)?.screen, a.id);
  const video = await b.page.evaluate(async (id) => {
    const element = document.createElement('video');
    element.muted = true;
    element.srcObject = window.media.remotes.get(id).screen;
    document.body.append(element);
    await element.play();
    await window.until(() => element.videoWidth > 0);
    const voice = window.media.remotes.get(id).voice;
    return {
      width: element.videoWidth,
      height: element.videoHeight,
      voiceTracks: voice?.getAudioTracks().length ?? 0,
      same: voice === element.srcObject,
    };
  }, a.id);
  assert.ok(video.width > 0 && video.height > 0, `the shared screen has frames, got ${JSON.stringify(video)}`);
  assert.equal(video.voiceTracks, 1, 'the voice stays beside the screen');
  assert.equal(video.same, false);

  // A late joiner gets both that are already on.
  const c = await join_();
  await wait(
    c,
    "C receives A's voice and screen",
    (id) => {
      const r = window.media.remotes.get(id);
      return !!r?.voice && !!r.screen;
    },
    a.id,
  );
  await wait(c, 'C hears A speaking', (id) => window.media.remotes.get(id)?.speaking === true, a.id);

  // A listener the user has not touched: its audio context starts suspended, and the first click lets it hear. Nothing
  // is evaluated in this page, since an evaluation counts as a user gesture.
  const untouched = await browser.newPage(),
    said = [];
  untouched.on('console', (message) => said.push(message.text()));
  await untouched.addInitScript((url) => {
    addEventListener('DOMContentLoaded', async () => {
      const { PeerMesh, SignalClient } = await import('/signal.js'),
        { openWebSocket } = await import('/websocket.js'),
        { MediaSession } = await import('/media.js'),
        mesh = new PeerMesh(await SignalClient.join(await openWebSocket(url), 'media')),
        media = new MediaSession(mesh, { pollMs: 20 });
      media.addEventListener('speaking', (e) => console.log(`speaking ${e.detail.peer} ${e.detail.speaking}`));
      const watch = setInterval(() => {
        if (!media.context) return;
        clearInterval(watch);
        console.log(`context ${media.context.state} ${navigator.userActivation.hasBeenActive}`);
      }, 20);
    });
  }, url);
  const heard = async (text) => {
    if (said.includes(text)) return;
    await untouched
      .waitForEvent('console', { predicate: (m) => m.text() === text, timeout: 15_000 })
      .catch(() => assert.fail(`the untouched listener never said "${text}"; it said ${JSON.stringify(said)}`));
  };
  await untouched.goto(`http://127.0.0.1:${web.address().port}/`);
  await heard('context suspended false');
  await untouched.bringToFront();
  await untouched.mouse.click(5, 5);
  await heard(`speaking ${a.id} true`);

  // Stopping removes each from every listener.
  await a.page.evaluate(() => window.media.stopScreenShare());
  for (const who of [b, c])
    await wait(
      who,
      'the screen goes, the voice stays',
      (id) => {
        const r = window.media.remotes.get(id);
        return !!r && r.screen === null && !!r.voice;
      },
      a.id,
    );
  await a.page.evaluate(() => window.media.stopVoice());
  for (const who of [b, c])
    await wait(
      who,
      'the voice goes and the speaking light with it',
      (id) => {
        const r = window.media.remotes.get(id);
        return !!r && r.voice === null && r.speaking === false;
      },
      a.id,
    );

  // The microphone starts again on the same links.
  await a.page.evaluate(() => window.media.startVoice());
  for (const who of [b, c])
    await wait(who, 'a restarted voice is heard', (id) => window.media.remotes.get(id)?.speaking === true, a.id);

  // Two talk at once, and disposing one session removes it for the others.
  await b.page.evaluate(() => window.media.startVoice());
  await wait(a, 'A hears B while B hears A', (id) => window.media.remotes.get(id)?.speaking === true, b.id);
  await a.page.evaluate(() => window.media.dispose());
  for (const who of [b, c])
    await wait(who, "a disposed sender's voice goes", (id) => window.media.remotes.get(id)?.voice === null, a.id);

  for (const who of [a, b, c]) assert.deepEqual(await who.page.evaluate(() => window.errors), []);
  console.log(`media proof passed: voice, mute, push-to-talk, screen, late join, restart; ${browser.version()}`);
} finally {
  clearTimeout(limit);
  await closeAll({ browser, servers: [web] });
  listener.close();
  signals.close();
  rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
}
