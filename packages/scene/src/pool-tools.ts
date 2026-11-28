// What templates need from the scene entries, loaded on the first instantiate so a pool used only for reference counts
// and preloads imports no engine code. It is the lazy target, not ./clone.js and ./index.js themselves: the container
// and the scene modules import those statically, so an import() of them would split nothing
// (tests/dist-dynamic-imports.test.js).
export { cloneSubtree } from './clone.js';
export { traverse, userData } from './index.js';
