/** JSON.parse for untrusted files: `__proto__`, `constructor` and `prototype` keys are removed at every depth. */
export function parseJSON<T = unknown>(text: string): T;
