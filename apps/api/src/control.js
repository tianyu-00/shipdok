// Start / stop / restart. The API records what the administrator wants and queues the work; only the worker has
// the Docker socket. desired_state is written FIRST so a stop takes effect for webhooks immediately (a stopped
// app is skipped), even while the worker is busy with a build and the job is still waiting its turn.

// The state each action asks for. An explicit restart of a stopped app is an explicit start.
const DESIRED = { stop: 'stopped', start: 'running', restart: 'running' };
export const CONTROL_ACTIONS = Object.keys(DESIRED);

/** @returns {{ ok: true, action: string, desired_state: string } | { ok: false }} */
export async function requestControl({ db, queue }, app, action) {
  const desired = DESIRED[action];
  if (!desired) throw new Error(`Unknown action: ${action}`);

  await db.query('UPDATE apps SET desired_state = $2, updated_at = now() WHERE id = $1', [app.id, desired]);
  try {
    await queue.add('control', { appId: app.id, action });
  } catch (err) {
    // Nothing will act on this request, so do not leave a wish nobody is carrying out.
    console.error('Enqueue failed:', err.message);
    await db.query(
      'UPDATE apps SET desired_state = $2, updated_at = now() WHERE id = $1 AND desired_state = $3',
      [app.id, app.desired_state, desired],
    );
    return { ok: false };
  }
  return { ok: true, action, desired_state: desired };
}
