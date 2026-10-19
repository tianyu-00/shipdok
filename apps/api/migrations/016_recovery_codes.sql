-- Recovery codes for the one administrator: only hashes are stored, each code works once, a new set replaces the old one.
CREATE TABLE recovery_codes (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id);

-- The host-side password reset is recorded as a sign-in kind of its own, and clears lockouts without deleting the history
-- of the failed tries: they stay in the list but no longer count.
ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_kind_check;
ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_kind_check CHECK (kind IN ('login', 'setup', 'recovery', 'reset'));
ALTER TABLE login_attempts ADD COLUMN forgiven boolean NOT NULL DEFAULT false;
