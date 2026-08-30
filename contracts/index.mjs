export { validateRoutingDecision } from "./decision.mjs";

export const RELAY_EVENTS_API_VERSION = 1;

export function validateRouterProvider(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("router provider is required");
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(provider.id ?? "")) {
    throw new TypeError("router provider requires a lowercase stable id");
  }
  if (typeof provider.route !== "function") throw new TypeError("router provider requires route()");
  return provider;
}

export function validateMonitorProvider(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("monitor provider is required");
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(provider.id ?? "")) {
    throw new TypeError("monitor provider requires a lowercase stable id");
  }
  for (const method of ["prepare", "checkMonitor"]) {
    if (typeof provider[method] !== "function") throw new TypeError(`monitor provider requires ${method}()`);
  }
  return provider;
}
