// A rope wrapped over bollards, pulleys, fairleads and winch drums with capstan friction, standalone (`WrappedRope`) or
// coupled both ways to the rigid world (`WrappedRopeSolver`). Its own entry, so a rod does not carry it.
export { WrappedRope, type WrappedRopeNode, type WrappedRopeOptions, type WrappedRopeWrap } from '../rod/wrapped.js';
export {
  WrappedRopeSolver,
  type WrappedRopeSolverNode,
  type WrappedRopeSolverParams,
  type WrappedRopeSolverWrap,
} from '../rod/wrapped-solver.js';
