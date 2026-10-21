-- How an app's image is made.
--   dockerfile  `docker build` with the repository's own Dockerfile (what every app was until now, so the default changes nothing).
--   railpack    no Dockerfile needed: Railpack looks at the code, works out how to build it and Shipdok builds that plan with `docker build`.
-- The three commands only apply to railpack and only when they are given (NULL = let Railpack decide). They are kept when the method is switched
-- back, so switching and switching back loses nothing. One line each: they are run by a shell inside the build, never by Shipdok itself.
ALTER TABLE apps
  ADD COLUMN build_method text NOT NULL DEFAULT 'dockerfile' CHECK (build_method IN ('dockerfile', 'railpack')),
  ADD COLUMN install_command text CHECK (install_command IS NULL OR (char_length(install_command) BETWEEN 1 AND 1000 AND install_command !~ '[[:cntrl:]]')),
  ADD COLUMN build_command text CHECK (build_command IS NULL OR (char_length(build_command) BETWEEN 1 AND 1000 AND build_command !~ '[[:cntrl:]]')),
  ADD COLUMN start_command text CHECK (start_command IS NULL OR (char_length(start_command) BETWEEN 1 AND 1000 AND start_command !~ '[[:cntrl:]]'));
