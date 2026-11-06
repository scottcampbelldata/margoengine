// The zlib inflater behind one dynamic import, so a KTX2 reader pays for it only on a zlib file.
export { inflateZlib } from '../../shared/inflate.js';
