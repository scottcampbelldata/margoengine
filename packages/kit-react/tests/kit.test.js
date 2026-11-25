import test from 'node:test';
import { checkKit } from '../../../tests/kit-support.js';
import * as kit from '@margoengine/kit-react';
test('kit-react has declared, equivalent and tree-shakable exports', { timeout: 120000 }, () =>
  checkKit('kit-react', kit),
);
