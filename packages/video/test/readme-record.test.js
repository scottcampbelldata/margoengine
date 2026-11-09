import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { readmeEntries } from '../../../scripts/support/readme-types.mjs';

test('recording README initializes before activation and records after audio is allowed', async () => {
  const entry = readmeEntries(readFileSync(new URL('../README.md', import.meta.url), 'utf8')).find(
    (e) => e.heading === 'Canvas recording with audio',
  );
  assert.ok(entry);
  const body = entry.code
    .replace(
      "import {recordCanvas} from 'margoengine/video/record';",
      'const {recordCanvas, document, AudioContext, setTimeout, console} = bindings;',
    )
    .replace('export {};', '');
  const { code } = await transformWithOxc(
    'export async function initialize(bindings) {\n' + body + '\n}',
    'recording.ts',
  );
  const { initialize } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  let contexts = 0,
    resumes = 0,
    records = 0,
    release;
  const allowed = new Promise((resolve) => {
    release = resolve;
  });
  const ended = [];
  let activate;
  const button = {
    textContent: '',
    addEventListener(type, fn) {
      assert.equal(type, 'click');
      activate = fn;
    },
  };
  const canvas = {
    getContext() {
      return { fillRect() {} };
    },
    remove() {
      ended.push('canvas');
    },
  };
  const destination = {
    stream: {
      getTracks: () => [
        {
          stop() {
            ended.push('track');
          },
        },
      ],
    },
  };
  class AudioContext {
    constructor() {
      contexts++;
    }
    createMediaStreamDestination() {
      return destination;
    }
    createOscillator() {
      return {
        connect(to) {
          assert.equal(to, destination);
        },
        start() {},
        stop() {
          ended.push('tone');
        },
      };
    }
    resume() {
      resumes++;
      return allowed;
    }
    async close() {
      ended.push('audio');
    }
  }
  const initialized = initialize({
    document: {
      createElement(type) {
        assert.ok(type === 'button' || type === 'canvas');
        return type === 'button' ? button : canvas;
      },
      body: { append() {} },
    },
    AudioContext,
    recordCanvas(target, options) {
      assert.equal(target, canvas);
      assert.equal(options.audio, destination.stream);
      records++;
      return {
        async stop() {
          return new Blob(['recorded'], { type: 'video/webm' });
        },
      };
    },
    setTimeout(resolve, ms) {
      assert.equal(ms, 1000);
      queueMicrotask(resolve);
    },
    console: {
      log(type, bytes) {
        assert.equal(type, 'video/webm');
        assert.ok(bytes > 0);
      },
    },
  });
  assert.equal(contexts, 0, 'module initialization must not create gesture-gated audio');
  await initialized;
  assert.equal(typeof activate, 'function');
  assert.match(button.textContent, /Record/);
  const finished = activate();
  assert.equal(contexts, 1);
  assert.equal(resumes, 1);
  assert.equal(records, 0, 'capture must wait for audio permission');
  release();
  await finished;
  assert.equal(records, 1);
  assert.deepEqual(ended, ['tone', 'track', 'audio', 'canvas']);
});
