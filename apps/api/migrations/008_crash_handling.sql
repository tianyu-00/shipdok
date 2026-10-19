-- Crash handling and ongoing health (SPEC.md section 11). Extends app_runtime and adds the crash history.

-- How many times Shipdok restarts a crashing app within the 10 minute window before it gives up and marks it crashed.
ALTER TABLE apps ADD COLUMN max_restarts integer NOT NULL DEFAULT 5 CHECK (max_restarts BETWEEN 0 AND 50);

ALTER TABLE app_runtime DROP CONSTRAINT app_runtime_state_check;
ALTER TABLE app_runtime ADD CONSTRAINT app_runtime_state_check
  CHECK (state IN ('running', 'stopped', 'unhealthy', 'restarting', 'crashed'));

ALTER TABLE app_runtime DROP CONSTRAINT app_runtime_last_action_check;
ALTER TABLE app_runtime ADD CONSTRAINT app_runtime_last_action_check
  CHECK (last_action IN ('deploy', 'start', 'stop', 'restart', 'auto_restart', 'recover'));

ALTER TABLE app_runtime
  ADD COLUMN last_exit_code   integer,
  ADD COLUMN oom_killed       boolean NOT NULL DEFAULT false,
  ADD COLUMN health_failures  integer NOT NULL DEFAULT 0,      -- consecutive failed health checks
  ADD COLUMN next_restart_at  timestamptz,                     -- when a scheduled automatic restart is due
  ADD COLUMN last_death_at    timestamptz,                     -- when the container exit already accounted for ended (so it is counted once)
  ADD COLUMN crash_reset_at   timestamptz;                     -- a manual Start/Restart or a new deployment forgives earlier crashes

-- One row per time the container stopped when it should have been running. Doubles as the crash counter for the window.
CREATE TABLE app_crash_events (
  id          bigserial PRIMARY KEY,
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  cause       text NOT NULL CHECK (cause IN ('crash', 'stopped_outside', 'recovered')),
  exit_code   integer,
  oom_killed  boolean NOT NULL DEFAULT false,
  action      text NOT NULL CHECK (action IN ('restart_scheduled', 'gave_up', 'none', 'restarted'))
);
CREATE INDEX app_crash_events_app_idx ON app_crash_events (app_id, occurred_at DESC);
