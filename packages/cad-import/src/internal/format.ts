// The CAD format a file extension names, shared by loadCAD and addCAD.
const extensions: Readonly<Record<string, 'stl' | 'obj' | 'step' | 'iges' | 'sat' | 'xt' | 'jt'>> = {
  stl: 'stl',
  obj: 'obj',
  step: 'step',
  stp: 'step',
  iges: 'iges',
  igs: 'iges',
  sat: 'sat',
  xt: 'xt',
  x_t: 'xt',
  x_b: 'xt',
  xmt_txt: 'xt',
  xmt_bin: 'xt',
  jt: 'jt',
};

/** The format named by `format`, else by the URL path's extension; undefined when neither names one. */
export function cadFormatOf(pathname: string, format?: string) {
  const name = format ?? pathname.toLowerCase().split('.').at(-1) ?? '';
  if (format !== undefined) return Object.values(extensions).find((f) => f === name);
  return Object.hasOwn(extensions, name) ? extensions[name] : undefined;
}
