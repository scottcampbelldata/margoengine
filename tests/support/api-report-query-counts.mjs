// Count the public Program query in the actual CLI module, including a Windows 8.3 import.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const require = createRequire(pathToFileURL(process.argv[1]));
const { API } = await import(pathToFileURL(require.resolve('typescript/unstable/async')));
const update = API.prototype.updateSnapshot;
let sourceFileLists = 0;
API.prototype.updateSnapshot = async function (...args) {
  const snapshot = await update.apply(this, args);
  for (const { program } of snapshot.getProjects()) {
    const names = program.getSourceFileNames;
    program.getSourceFileNames = function (...args) {
      sourceFileLists++;
      return names.apply(this, args);
    };
  }
  return snapshot;
};
process.on('exit', () => writeFileSync(process.env.MARGO_API_QUERY_COUNTS, JSON.stringify({ sourceFileLists })));
