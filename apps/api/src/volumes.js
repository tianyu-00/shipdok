// What a deployment mounts: the volumes of an app that are in use, as { path, name }, sorted by path.
export async function mountedVolumes(db, appId) {
  const { rows } = await db.query(`SELECT container_path, docker_name FROM app_volumes WHERE app_id = $1 AND state = 'in_use' ORDER BY container_path`, [appId]);
  return rows.map((r) => ({ path: r.container_path, name: r.docker_name }));
}
