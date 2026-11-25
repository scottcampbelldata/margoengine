// Real-GPU check of GAP-FILM-RESET for TAA: seek, resetClocks, then a frame bit-equal to a fresh clock's.
// Run from the repository root after building packages: node packages/taa/test/reset-browser.mjs (MARGO_COMPAT=1 for the WebGL2 layer).
import { resetFrameCheck } from '../../../tests/support/reset-frame-browser.mjs';

await resetFrameCheck('taa-reset', 5481, 'taa');
