// Worker script for @margoengine/loaders/worker (bundled to dist/workers/usd.js).
import { serve } from '../../shared/worker.js';
import { parseUSDA, parseUSDZ } from './usdz.js';
serve(({ format, input, options }) => (format === 'usdz' ? parseUSDZ(input, options) : parseUSDA(input, options)));
