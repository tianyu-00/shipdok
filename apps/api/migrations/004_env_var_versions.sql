-- Every change to a variable gets a new, globally unique version number. A deployment records
-- the versions it used (never values), so "pending changes" is a comparison of numbers. Using one
-- sequence means deleting and re-adding a variable can never look unchanged.
CREATE SEQUENCE app_env_var_version_seq;
ALTER TABLE app_env_vars
  ADD COLUMN version bigint NOT NULL DEFAULT nextval('app_env_var_version_seq');
