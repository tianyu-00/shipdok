-- How big each persistent volume is. Docker needs several seconds to add a volume up (it walks every file), so this is never measured by itself:
-- the administrator asks ("Measure sizes"), the worker measures all volumes in one go and writes the figures here with the time.
--   app_volumes.size_bytes / measured_at   the last measurement of that volume (NULL: never measured, or Docker has no such volume yet)
--   volume_sizing                          one row: a measurement was asked for and not yet finished (requested_at), and how the last one went
ALTER TABLE app_volumes ADD COLUMN size_bytes bigint, ADD COLUMN measured_at timestamptz;

CREATE TABLE volume_sizing (
  id           smallint PRIMARY KEY CHECK (id = 1),
  requested_at timestamptz,
  finished_at  timestamptz,
  last_error   text
);
INSERT INTO volume_sizing (id) VALUES (1);
