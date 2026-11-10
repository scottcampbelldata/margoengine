import { exposeRpc } from '../dist/rpc.js';
exposeRpc({
  prepare() {
    return false;
  },
});
