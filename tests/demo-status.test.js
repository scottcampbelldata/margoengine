// KB-DEMO-STATUS1: demos wrote `data-ready` and their status text themselves, so an error shown by `onError` (a lost
// device, an uncaptured GPU error) was overwritten a moment later by the ready line with `data-ready` still set, and a
// page check passed a page that had failed. examples/demo-status.ts is the one place that marks a page ready or
// failed; after an error it marks nothing ready. The static test keeps every demo on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoStatus, errorText } from '../examples/demo-status.ts';

const element = () => ({ dataset: {}, textContent: '' });

test('an error keeps its text and no later ready marks the page', () => {
  const target = element(),
    status = element(),
    page = demoStatus(target, status);
  page.pending('Loading');
  assert.equal(status.textContent, 'Loading');
  assert.equal(target.dataset.ready, undefined);
  page.error(new Error('device lost'));
  assert.equal(page.failed, true);
  assert.equal(page.ready('200 meshes drawn.'), false);
  assert.equal(status.textContent, 'device lost');
  assert.equal(target.dataset.ready, undefined);
  assert.equal(target.dataset.error, 'device lost');
  // A second error (the device lost after a validation error) keeps the first one on screen.
  page.error('second');
  assert.equal(status.textContent, 'device lost');
  assert.equal(target.dataset.error, 'device lost');
});

test('an error after ready clears data-ready; ready takes a value; errors can show apart', () => {
  const target = element(),
    status = element(),
    errors = element(),
    page = demoStatus(target, status, errors);
  assert.equal(page.ready('Ready.', 'hemibrain'), true);
  assert.equal(target.dataset.ready, 'hemibrain');
  assert.equal(status.textContent, 'Ready.');
  page.error(new TypeError('bad input'));
  assert.equal(target.dataset.ready, undefined);
  assert.equal(errors.textContent, 'bad input');
  assert.equal(status.textContent, 'Ready.');
  assert.equal(errorText(42), '42');
});

test('ready without text leaves the status as it is', () => {
  const target = element(),
    status = element();
  status.textContent = 'kept';
  assert.equal(demoStatus(target, status).ready(), true);
  assert.equal(target.dataset.ready, 'true');
  assert.equal(status.textContent, 'kept');
  // No status element at all.
  assert.equal(demoStatus(target).ready('ignored'), true);
});

test('no demo writes data-ready itself', () => {
  const root = fileURLToPath(new URL('../examples/', import.meta.url)),
    found = [],
    walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === 'node_modules' || name === 'dist' || name === 'assets') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|mjs)$/.test(name) && name !== 'demo-status.ts') {
          const text = readFileSync(path, 'utf8');
          if (/dataset\.ready\s*=(?!=)|delete\s+[\w.]+\.dataset\.ready|setAttribute\(\s*['"]data-ready/.test(text))
            found.push(relative(root, path).replaceAll('\\', '/'));
        }
      }
    };
  walk(root);
  assert.deepEqual(found, [], 'use demoStatus from examples/demo-status.ts');
});
