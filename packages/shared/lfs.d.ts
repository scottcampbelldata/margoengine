/** Throws MargoError `failed` (errors page #git-lfs) when `data` is a Git LFS pointer file; `name` is the URL or input. */
export function rejectLFSPointer(data: Uint8Array | string, name: string): void;
