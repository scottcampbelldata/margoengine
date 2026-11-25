import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { PostProcessing } from '../dist/post.js';

test('PostProcessing.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new PostProcessing(), { label: 'PostProcessing' });
});
