-- Environment variables for apps. Values are stored encrypted (AES-256-GCM, see
-- packages/shared/src/crypto.js); this table never holds a plaintext value.
CREATE TABLE app_env_vars (
  app_id          uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key             text NOT NULL CHECK (key ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  value_encrypted text NOT NULL CHECK (value_encrypted LIKE 'v1:%'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, key)
);
