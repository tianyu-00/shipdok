-- What is actually happening to an app's live container, as last reported by the worker.
-- Three separate ideas, deliberately not mixed: apps.desired_state is what the administrator WANTS,
-- deployments.status is how a DEPLOYMENT went, and this table is what the app is DOING now.
-- The API has no Docker access, so it only ever reads this; the worker writes it.
CREATE TABLE app_runtime (
  app_id      uuid PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  state       text NOT NULL CHECK (state IN ('running', 'stopped', 'unhealthy')),
  last_action text CHECK (last_action IN ('deploy', 'start', 'stop', 'restart')),
  last_error  text,                       -- why the last action failed; NULL when it worked
  updated_at  timestamptz NOT NULL DEFAULT now()
);
