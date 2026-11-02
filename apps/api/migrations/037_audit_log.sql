-- The activity log: what was done with the password (and, later, other things the administrator does), with what changed.
-- It is apart from login_attempts, which the sign-in lockout reads. `details` is a list of { label, from, to } or { label, value }:
-- never a secret. `source` is who started it: the administrator (user), or something automatic (webhook, schedule, system).
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL CHECK (category IN ('security', 'github', 'backups', 'apps', 'deployments', 'variables', 'storage')),
  action text NOT NULL,
  summary text NOT NULL,
  details jsonb,
  actor text NOT NULL,
  address text NOT NULL,
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'webhook', 'schedule', 'system')),
  app_id uuid,
  app_name text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC, id DESC);
CREATE INDEX audit_log_category_idx ON audit_log (category, at DESC);

-- What the old list held besides sign-ins moves here (without details: they were not recorded), and the sign-in table goes back to sign-ins only.
INSERT INTO audit_log (at, category, action, summary, actor, address)
SELECT at,
       CASE kind WHEN 'github' THEN 'github' WHEN 'backup' THEN 'backups' WHEN 'download' THEN 'backups' WHEN 'restore' THEN 'backups' ELSE 'security' END,
       CASE kind WHEN 'settings' THEN 'public_access' WHEN 'github' THEN 'github_changed' WHEN 'backup' THEN 'backup_passphrase' WHEN 'download' THEN 'backup_download'
                 WHEN 'restore' THEN 'restore' ELSE 'log_keeping' END,
       CASE kind WHEN 'settings' THEN 'Public access changed' WHEN 'github' THEN 'GitHub changed' WHEN 'backup' THEN 'Backup passphrase changed'
                 WHEN 'download' THEN 'Backup downloaded' WHEN 'restore' THEN 'Restore started' ELSE 'Log keeping time changed' END,
       username, address
FROM login_attempts WHERE kind NOT IN ('login', 'setup', 'recovery', 'reset') ORDER BY at, id;
DELETE FROM login_attempts WHERE kind NOT IN ('login', 'setup', 'recovery', 'reset');
ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_kind_check;
ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_kind_check CHECK (kind IN ('login', 'setup', 'recovery', 'reset'));
