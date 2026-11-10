// The UI renderer's lazy door to the WebGL2 painter. renderer.ts loads this module with import() on the preview
// backend, while the ./world-gl entry imports gl.ts statically; a separate door keeps any module from importing gl.js
// both ways, so the import() still splits for apps that link both entries (tests/dist-dynamic-imports.test.js).
import { GlUiPainter } from './gl.js';

/** Creates the WebGL2 UI painter. */
export const glPainter = (...args: ConstructorParameters<typeof GlUiPainter>): GlUiPainter => new GlUiPainter(...args);
