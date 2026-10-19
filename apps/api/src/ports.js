// Automatic host ports. A new app that is not given one gets the lowest free port in a range.
// The default range sits above the ports people use for databases and dashboards (9000 Portainer/SonarQube, 9090 Prometheus,
// 9200 Elasticsearch, 9229 the Node inspector) and below Linux's own temporary ports (from 32768), so nothing collides by accident.
export const DEFAULT_PORT_RANGE = '20000-20999';

/** "20000-20999" -> { min, max }. Throws a message that says what to fix. */
export function parsePortRange(text = DEFAULT_PORT_RANGE) {
  // An en or em dash is accepted too: ranges copied from a web page or a chat usually carry one.
  const m = /^\s*(\d{1,5})\s*[-\u2013\u2014]\s*(\d{1,5})\s*$/.exec(String(text));
  if (!m) throw new Error(`PORT_RANGE must look like 20000-20999 (got "${text}")`);
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min < 1024 || max > 65535) throw new Error('PORT_RANGE must stay between 1024 and 65535');
  if (min > max) throw new Error('PORT_RANGE must start below where it ends');
  return { min, max };
}

/** The lowest port in the range no app has, or null when the range is full. Ports used by anything else on the machine are not visible from here. */
export async function nextFreePort(db, { min, max }) {
  const { rows } = await db.query('SELECT host_port FROM apps WHERE host_port BETWEEN $1 AND $2 ORDER BY host_port', [min, max]);
  let candidate = min;
  for (const { host_port: used } of rows) {
    if (used > candidate) break;
    if (used === candidate) candidate += 1;
  }
  return candidate <= max ? candidate : null;
}
