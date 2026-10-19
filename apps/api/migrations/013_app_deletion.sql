-- Deleting an app is done by the worker (it is the only thing that talks to Docker): the API marks the app as "being deleted" and
-- queues a job. delete_error holds why the last attempt failed, so the dashboard can say so and offer a retry.
ALTER TABLE apps
  ADD COLUMN deleting_at  timestamptz,
  ADD COLUMN delete_error text;
