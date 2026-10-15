// Worker script for @margoengine/gltf-pro/worker (bundled to dist/workers/gltf.js).
import {serve} from '../../shared/worker.js';
import {prepareGLTF} from './prepare.js';
serve(({url, input, buffers, maxDownloadBytes, maxNodes}) => prepareGLTF(url, input, buffers, maxDownloadBytes, maxNodes));
