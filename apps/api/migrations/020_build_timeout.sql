-- How long a build (the clone plus `docker build`) may take before it is stopped, per app. NULL = no limit (the default).
-- 5 minutes to 7 days: a longer number would mean "no limit" anyway, and setTimeout cannot count past about 24 days.
ALTER TABLE apps ADD COLUMN build_timeout_minutes integer CHECK (build_timeout_minutes IS NULL OR build_timeout_minutes BETWEEN 5 AND 10080);
