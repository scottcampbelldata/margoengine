import test from 'node:test';
import { checkKit } from '../../../tests/kit-support.js';
import * as kit from '@margoengine/web';
test('web has declared, equivalent and tree-shakable exports', { timeout: 120000 }, () => checkKit('web', kit));
