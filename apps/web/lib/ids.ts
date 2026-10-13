/** e.g. `INC-3F9A1C2E`: short enough to read out on a call, random enough not to collide. */
export function newIncidentId(prefix = 'INC') {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}
