-- A third way to make an app's image: a static site (HTML, CSS, JavaScript) served by a small web server (nginx, not as root).
-- Shipdok writes the Dockerfile itself. static_server picks the web server: nginx (not run as root) or Caddy. An optional build (the install and build commands, which are the same two columns Railpack uses) runs in a
-- Node image of the chosen version; the output folder is then copied into the web server's image. No build command = the folder is served as it is.
--   output_dir      the folder, relative to the app's folder in the repository, that is served (NULL = the app's folder itself)
--   node_version    the Node image used for the build ("22", "20.11", "18.20.4"); NULL = the default Shipdok picks
--   spa_fallback    an address with no file behind it shows index.html (what a single-page app needs); off = a plain 404
-- All three are kept when the method is switched, like the commands.
ALTER TABLE apps DROP CONSTRAINT apps_build_method_check;
ALTER TABLE apps
  ADD CONSTRAINT apps_build_method_check CHECK (build_method IN ('dockerfile', 'railpack', 'static')),
  ADD COLUMN output_dir text CHECK (output_dir IS NULL OR (char_length(output_dir) BETWEEN 1 AND 200 AND output_dir ~ '^[A-Za-z0-9._/-]+$' AND output_dir !~ '^/' AND output_dir !~ '(^|/)\.\.(/|$)')),
  ADD COLUMN node_version text CHECK (node_version IS NULL OR node_version ~ '^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$'),
  ADD COLUMN spa_fallback boolean NOT NULL DEFAULT true,
  ADD COLUMN static_server text NOT NULL DEFAULT 'nginx' CHECK (static_server IN ('nginx', 'caddy'));
