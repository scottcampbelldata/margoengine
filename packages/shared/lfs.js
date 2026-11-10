// A repository cloned without Git LFS serves pointer files (small text stubs starting `version https://git-lfs`) in place
// of its models. A loader that parses them reports invalid JSON or a truncated buffer, which does not say what to do.
import { fault } from './errors.js';

const POINTER = 'version https://git-lfs';

/** Throws MargoError `failed` (errors page #git-lfs) when `data` is a Git LFS pointer file; `name` is the URL or input. */
export function rejectLFSPointer(data, name) {
  if (data.length < POINTER.length) return;
  for (let i = 0; i < POINTER.length; i++)
    if ((typeof data === 'string' ? data.charCodeAt(i) : data[i]) !== POINTER.charCodeAt(i)) return;
  throw fault(
    'failed',
    `${name} is a Git LFS pointer file, not the asset; run git lfs pull and serve the real file`,
    'git-lfs',
  );
}
