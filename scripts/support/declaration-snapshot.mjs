// Hygiene gate 6 reads every package's dist/*.d.ts through TypeScript's async API. A package build (vite with
// emptyOutDir, run by most packages' `npm test`) empties its dist and writes it again; a gate that opens its TypeScript
// project during that window finds no source file for the entry, and the API then threw the unhelpful
// "getNodeId requires a RemoteNode" (KB6254a). These helpers name the cause instead.
import { statSync } from 'node:fs';

/** Modification time in ms of each declaration file, or -1 when it is missing. */
export function declarationStamps(files) {
  return files.map((file) => {
    try {
      return statSync(file).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') return -1;
      throw error;
    }
  });
}

/** The declaration files whose stamps differ between two `declarationStamps` reads of the same list. */
export function changedDeclarations(files, before, after) {
  return files.filter((_, i) => before[i] !== after[i]);
}

/** The error to throw when the program has no source file for `dts`, naming a rebuild that ran beside the gate. */
export function missingDeclaration(dts, changed) {
  return new Error(
    changed.length
      ? `${dts} is not in the declaration program: ${changed.length} declaration file(s) changed while hygiene read them ` +
          `(first ${changed[0]}), so a package build ran beside it; run hygiene after builds and package tests finish`
      : `${dts} is not in the declaration program; run npm run build:packages, then hygiene`,
  );
}
