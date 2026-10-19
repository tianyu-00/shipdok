-- Live resource use of each app's running container, sampled by the worker (the API never talks to Docker).
-- Short-lived on purpose: the worker removes samples older than an hour, so this stays small even on a Pi.
CREATE TABLE app_stats (
  app_id             uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  sampled_at         timestamptz NOT NULL DEFAULT now(),
  cpu_percent        real,                 -- percent of ONE cpu (200 = two cpus fully busy); NULL when Docker could not say
  memory_bytes       bigint NOT NULL,      -- in use, without the page cache the kernel can take back
  memory_limit_bytes bigint                -- the container's limit; NULL when none
);
CREATE INDEX app_stats_app_time_idx ON app_stats (app_id, sampled_at DESC);
