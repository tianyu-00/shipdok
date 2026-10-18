-- GitHub webhook deliveries: deduplication by GitHub's delivery id, plus a history that answers
-- "why didn't my push deploy?". Nothing here is a secret: payloads themselves are never stored.
CREATE TABLE webhook_deliveries (
  delivery_id  text PRIMARY KEY CHECK (delivery_id ~ '^[A-Za-z0-9-]{8,64}$'),  -- X-GitHub-Delivery
  event        text NOT NULL CHECK (event ~ '^[a-z_]{1,40}$'),                  -- X-GitHub-Event
  repo         text,
  ref          text,
  commit_sha   text,
  outcome      text NOT NULL CHECK (outcome IN ('processing', 'deployed', 'ignored', 'error')),
  reason       text,
  details      jsonb,                                                           -- per-app results
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX webhook_deliveries_received_idx ON webhook_deliveries (received_at DESC);

-- Which delivery caused a deployment. At most one deployment per (delivery, app): a redelivery can never
-- create a second one for the same app.
ALTER TABLE deployments
  ADD COLUMN webhook_delivery_id text REFERENCES webhook_deliveries(delivery_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX deployments_webhook_delivery_app_key
  ON deployments (webhook_delivery_id, app_id) WHERE webhook_delivery_id IS NOT NULL;
