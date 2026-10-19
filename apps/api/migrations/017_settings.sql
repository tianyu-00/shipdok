-- Settings the administrator changes in the dashboard (public access for now; GitHub App credentials later).
-- One row per setting, the value as JSON. A setting given in the environment overrides the row.
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Changing a setting is recorded in the sign-ins list as an entry of its own.
ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_kind_check;
ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_kind_check CHECK (kind IN ('login', 'setup', 'recovery', 'reset', 'settings'));
