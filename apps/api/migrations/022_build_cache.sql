-- Docker's build cache is shared by every build, so it has no owner and lives in one row (id = 1).
--   total_bytes / reclaimable_bytes / sampled_at   the worker's last look (it measures now and then; the API never talks to Docker)
--   requested_at                                   a clean-up was queued and has not finished; cleared when the worker records the result
--   last_*                                         the most recent clean-up: when it finished, whether it cleared everything, what it freed, why it failed
CREATE TABLE build_cache (
  id                 smallint PRIMARY KEY CHECK (id = 1),
  total_bytes        bigint,
  reclaimable_bytes  bigint,
  sampled_at         timestamptz,
  requested_at       timestamptz,
  requested_all      boolean,
  last_run_at        timestamptz,
  last_all           boolean,
  last_freed_bytes   bigint,
  last_error         text
);
INSERT INTO build_cache (id) VALUES (1);
