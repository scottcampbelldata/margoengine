// A readiness check observes the current plugin map, not an attachment history.
export function activePlugins(engine, prefix) {
  return engine ? [...engine.plugins.values()].filter((plugin) => plugin.name.startsWith(prefix)) : [];
}
