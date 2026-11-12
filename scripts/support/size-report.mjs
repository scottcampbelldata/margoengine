// What `npm run build:packages` prints about bundle sizes. The full record always goes to
// test-results/modern-bundle-sizes.json; the terminal gets one line, or the whole JSON with --sizes or MARGO_BUILD_VERBOSE=1.
export const SIZES_FILE = 'test-results/modern-bundle-sizes.json';

export function wantsFullSizes(argv, env) {
  return argv.includes('--sizes') || env.MARGO_BUILD_VERBOSE === '1';
}

export function sizeReport(sizes, { full }) {
  if (full) return JSON.stringify(sizes, null, 2);
  const names = Object.keys(sizes).length;
  return `Packages built. Core and stage together: ${sizes.base.gzip.toLocaleString('en-US')} B gzip (${names} sizes in ${SIZES_FILE}; run with --sizes to print them).`;
}
