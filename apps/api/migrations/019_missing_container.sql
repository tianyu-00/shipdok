-- A container removed outside Shipdok (for example `docker rm`): the app is shown as missing, and the crash history gets an entry.
ALTER TABLE app_runtime DROP CONSTRAINT app_runtime_state_check;
ALTER TABLE app_runtime ADD CONSTRAINT app_runtime_state_check
  CHECK (state IN ('running', 'stopped', 'unhealthy', 'restarting', 'crashed', 'missing'));

ALTER TABLE app_crash_events DROP CONSTRAINT app_crash_events_cause_check;
ALTER TABLE app_crash_events ADD CONSTRAINT app_crash_events_cause_check
  CHECK (cause IN ('crash', 'stopped_outside', 'recovered', 'removed_outside'));
