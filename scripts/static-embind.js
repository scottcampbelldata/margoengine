// Emscripten's embind builds every C++ call wrapper with `new Function` unless the module was compiled with
// DYNAMIC_EXECUTION=0, so a prebuilt embind glue file fails under a CSP without 'unsafe-eval'. Those wrappers are
// JavaScript only (the .wasm is the same either way), so this rewrites the glue's two code generators into the closures
// DYNAMIC_EXECUTION=0 emits instead. Used on the Basis transcoder (packages/decoders) and occt-import-js (machinery).
// The patterns are exact: a different Emscripten version fails the build here instead of shipping an unpatched file.

const patches = [
  // craftInvokerFunction: the wrapper behind every bound function, method and constructor. Same steps as the generated
  // body: wire `this` and each argument, call, run destructors, convert the return value.
  ['let[args,invokerFnBody]=createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync);args.push(invokerFnBody);var invokerFn=newFunc(Function,args)(...closureArgs);',
    'var invokerFn=function(...args){var destructors=needsDestructorStack?[]:null,wired=[cppTargetFunc];' +
    'if(isClassMethodFunc)wired.push(argTypes[1].toWireType(destructors,this));' +
    'for(var i=2;i<argTypes.length;++i)wired.push(argTypes[i].toWireType(destructors,args[i-2]));' +
    'var rv=cppInvokerFunc(...wired);' +
    'if(needsDestructorStack)runDestructors(destructors);' +
    'else for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var dtor=argTypes[i].destructorFunction;if(dtor!==null)dtor(wired[isClassMethodFunc?i:i-1])}' +
    'if(returns)return argTypes[0].fromWireType(rv)};'],
  // _emval_get_method_caller: C++ calling a JavaScript function or method through emscripten::val. Kind 0 calls with
  // `obj` as `this`, kind 1 constructs, any other kind passes the first argument as `this`, as the generated body does.
  ['params.push(functionBody);var invokerFunction=newFunc(Function,params)(...args);',
    'var invokerFunction=(obj,func,destructorsRef,argsPointer)=>{var values=[],offset=0;' +
    'for(var i=0;i<argCount;++i){values.push(types[i].readValueFromPointer(argsPointer+offset));offset+=types[i].argPackAdvance}' +
    'var rv=kind===1?Reflect.construct(func,values):kind===0?func.apply(obj,values):func.call(...values);' +
    'return retType.isVoid?undefined:emval_returnValue(retType,destructorsRef,rv)};'],
];

/**
 * Return `source` (an Emscripten embind glue script) with its `new Function` wrapper generators replaced by closures.
 * Throws when a pattern is missing or repeated, or when any `newFunc(Function, ...)` call survives.
 * @param {string} source
 * @param {string} name file name for the error message and the modification notice
 * @returns {string}
 */
export function staticEmbind(source, name) {
  let out = source;
  for (const [from, to] of patches) {
    const at = out.indexOf(from);
    if (at < 0 || out.indexOf(from, at + 1) >= 0) throw new Error(`${name}: embind pattern not found exactly once (Emscripten version changed?): ${from.slice(0, 60)}`);
    out = out.slice(0, at) + to + out.slice(at + from.length);
  }
  if (out.includes('newFunc(Function')) throw new Error(`${name}: dynamic embind code remains`);
  return `/* ${name}, modified by Margo Engine's build (scripts/static-embind.js): embind's two \`new Function\` wrapper generators are replaced by equivalent closures (Emscripten's DYNAMIC_EXECUTION=0 form) so it runs without 'unsafe-eval'. Otherwise unchanged. */\n` + out;
}
