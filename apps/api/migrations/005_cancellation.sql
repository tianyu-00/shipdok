-- Cancellation and "latest deployment wins".
--
-- cancel_status records WHAT a deployment should end as; status only changes once the worker
-- has actually stopped and cleaned up, so history stays honest about what really happened.
-- superseded_by links an older deployment to the one that replaced it.
-- seq is a strict, gap-tolerant ordering of deployments (timestamps can tie or invert under concurrency).
ALTER TABLE deployments
  ADD COLUMN cancel_status  text CHECK (cancel_status IN ('cancelled', 'superseded')),
  ADD COLUMN superseded_by  uuid REFERENCES deployments(id) ON DELETE SET NULL,
  ADD COLUMN seq            bigint;

-- Deterministic backfill for existing rows, oldest first.
UPDATE deployments d SET seq = r.n
FROM (SELECT id, row_number() OVER (ORDER BY queued_at, id) AS n FROM deployments) r
WHERE d.id = r.id;

CREATE SEQUENCE deployments_seq_seq OWNED BY deployments.seq;
SELECT setval('deployments_seq_seq', COALESCE((SELECT max(seq) FROM deployments), 0) + 1, false);
ALTER TABLE deployments ALTER COLUMN seq SET DEFAULT nextval('deployments_seq_seq');
ALTER TABLE deployments ALTER COLUMN seq SET NOT NULL;
CREATE UNIQUE INDEX deployments_seq_key ON deployments (seq);
