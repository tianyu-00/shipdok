-- Every login attempt, successful or not: the recent-logins list and the progressive lockout both read this.
-- `username` is whatever was typed (cut to 64 characters), so attempts on names that do not exist are counted too.
CREATE TABLE login_attempts (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  kind     text NOT NULL CHECK (kind IN ('login', 'setup', 'recovery')),
  username text NOT NULL,
  address  text NOT NULL,
  success  boolean NOT NULL
);
CREATE INDEX login_attempts_at_idx ON login_attempts (at DESC);
CREATE INDEX login_attempts_username_idx ON login_attempts (username, at DESC);
CREATE INDEX login_attempts_address_idx ON login_attempts (address, at DESC);
