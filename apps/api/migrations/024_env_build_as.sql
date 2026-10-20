-- How a variable that reaches the build is handed to `docker build`:
--   arg     `--build-arg NAME` (what every build variable was until now, so the default changes nothing). A Dockerfile that uses it bakes the value into the image.
--   secret  `--secret id=NAME,env=NAME`: BuildKit mounts it for the one RUN step that asks for it and it is never stored in the image.
-- It only matters when the scope reaches the build. Changing it also gets a new version number (done in the application), like any change.
ALTER TABLE app_env_vars
  ADD COLUMN build_as text NOT NULL DEFAULT 'arg' CHECK (build_as IN ('arg', 'secret'));
