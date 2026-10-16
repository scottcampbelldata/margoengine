import test from 'node:test';
import assert from 'node:assert/strict';
import { optionalPeer } from '../dist/optional.js';

test('browser import failures name the optional peer and preserve the original cause', async () => {
  const cause = new TypeError('Failed to fetch dynamically imported module');
  await assert.rejects(
    optionalPeer('@margoengine/geometry', async () => {
      throw cause;
    }),
    (error) => {
      assert.match(error.message, /@margoengine\/geometry/);
      assert.match(error.message, /Install/);
      assert.equal(error.cause, cause);
      return true;
    },
  );
});
test('native missing-peer errors keep their identity and code when the package is already named', async () => {
  const cause = Object.assign(new Error('Cannot find package @margoengine/animation'), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
  await assert.rejects(
    optionalPeer('@margoengine/animation', async () => {
      throw cause;
    }),
    (error) => error === cause,
  );
});
