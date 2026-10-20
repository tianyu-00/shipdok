-- Several GitHub Apps instead of one. Each is entered in the dashboard (Connect GitHub, or by hand) and each Shipdok app is assigned to ONE of them
-- (`apps.github_app_id`): that app lists the repositories, clones private code and is the one whose webhooks deploy the app.
-- The private key, the webhook secret and the client secret are stored encrypted with the platform key (AES-256-GCM, each bound to its field name
-- and, for every app added from now on, to this row's id as well); everything else is plain information. Nothing here is ever returned to the browser
-- except the plain part.
CREATE TABLE github_apps (
  id                 uuid PRIMARY KEY,
  app_id             bigint NOT NULL UNIQUE,      -- GitHub's own number for the app: the same GitHub App cannot be connected twice
  slug               text,
  name               text,
  owner_login        text,
  html_url           text,
  client_id          text,
  private_key_enc    text NOT NULL,
  webhook_secret_enc text NOT NULL,
  client_secret_enc  text,
  source             text NOT NULL CHECK (source IN ('manifest', 'manual')),
  -- The app that was connected before there could be several was encrypted for the field name alone; it stays readable that way until it is
  -- replaced (entering it again saves it the new way).
  legacy_context     boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO github_apps (id, app_id, slug, name, owner_login, html_url, client_id, private_key_enc, webhook_secret_enc, client_secret_enc, source, legacy_context, created_at, updated_at)
SELECT gen_random_uuid(), app_id, slug, name, owner_login, html_url, client_id, private_key_enc, webhook_secret_enc, client_secret_enc, source, true, created_at, updated_at
  FROM github_app;

-- A project's GitHub App. Removing the GitHub App leaves the project without one (the application also forgets the installation then).
ALTER TABLE apps ADD COLUMN github_app_id uuid REFERENCES github_apps(id) ON DELETE SET NULL;
CREATE INDEX apps_github_app_id_idx ON apps (github_app_id);

-- Everything that exists before this was using the one app: it keeps using it.
UPDATE apps SET github_app_id = (SELECT id FROM github_apps ORDER BY created_at LIMIT 1) WHERE (SELECT count(*) FROM github_apps) = 1;

DROP TABLE github_app;
