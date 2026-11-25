// Real-GPU check of GAP-FILM-RESET for VolumetricFog: seek, resetClocks, then a frame bit-equal to a fresh clock's.
// Run from the repository root after building packages: node packages/environment/tests/fog-reset-browser.mjs (MARGO_COMPAT=1 for the WebGL2 layer).
import { resetFrameCheck } from '../../../tests/support/reset-frame-browser.mjs';

await resetFrameCheck('fog-reset', 5483, 'fog');
