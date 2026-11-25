// Real-GPU check of GAP-FILM-RESET for Tonemap: seek, resetClocks, then a frame bit-equal to a fresh clock's.
// Run from the repository root after building packages: node packages/tonemap/tests/reset-browser.mjs (MARGO_COMPAT=1 for the WebGL2 layer).
import { resetFrameCheck } from '../../../tests/support/reset-frame-browser.mjs';

await resetFrameCheck('tonemap-reset', 5482, 'tonemap');
