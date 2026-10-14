-- Session table for connect-pg-simple (schema from its documentation).
CREATE TABLE "session" (
  "sid"    varchar PRIMARY KEY,
  "sess"   json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX "IDX_session_expire" ON "session" ("expire");
