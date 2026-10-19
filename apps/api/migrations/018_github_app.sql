-- The GitHub App Shipdok uses, entered in the dashboard (Connect GitHub, or by hand). One row at most.
-- The private key, the webhook secret and the client secret are stored encrypted with the platform key (AES-256-GCM, each bound to its
-- field name); everything else is plain information about the app. Nothing here is ever returned to the browser except the plain part.
CREATE TABLE github_app (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  app_id            bigint NOT NULL,
  slug              text,
  name              text,
  owner_login       text,
  html_url          text,
  client_id         text,
  private_key_enc   text NOT NULL,
  webhook_secret_enc text NOT NULL,
  client_secret_enc text,
  source            text NOT NULL CHECK (source IN ('manifest', 'manual')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Connecting, replacing and disconnecting the app are recorded in the sign-ins list.
ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_kind_check;
ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_kind_check CHECK (kind IN ('login', 'setup', 'recovery', 'reset', 'settings', 'github'));
