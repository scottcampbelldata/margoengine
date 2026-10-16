// JSON from model files (glTF/GLB, .margo) reaches apps through `extras`, extensions and `asset.doc`. JSON.parse never
// pollutes Object.prototype itself, but a `"__proto__"` key is an own property that an app's Object.assign or deep merge
// would turn into a prototype swap. Such keys (and `constructor` / `prototype`) are dropped while parsing; the reviver
// only runs when the text could contain one (escaped keys such as `"__proto__"` included), so ordinary files
// parse at full JSON.parse speed.
const risky = /"(?:__proto__|constructor|prototype)"|\\u/;
const drop = (key, value) => (key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value);

/** JSON.parse for untrusted files: `__proto__`, `constructor` and `prototype` keys are removed at every depth. */
export const parseJSON = (text) => (risky.test(text) ? JSON.parse(text, drop) : JSON.parse(text));
