-- Where a variable is available:
--   runtime  the running container only (what every variable was until now, so the default changes nothing)
--   build    `docker build --build-arg` only; the container never sees it
--   both     both
-- Changing the scope also gets a new version number (done in the application, like a change of value), so "pending changes" notices it.
ALTER TABLE app_env_vars
  ADD COLUMN scope text NOT NULL DEFAULT 'runtime' CHECK (scope IN ('runtime', 'build', 'both'));
