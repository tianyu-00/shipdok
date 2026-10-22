// Building a static site: HTML, CSS and JavaScript served by a small web server, with an optional build first.
//
// Shipdok writes the Dockerfile itself (the repository's own, if it has one, is not used) and builds it with the same `docker build` as every other
// app, so the build cache, the time limit, cancelling, the log and the labels (given to `docker build` directly) all work as they always did.
//
//   stage 1 (only when there is an install or a build command)  a Node image of the chosen version: the repository is copied in, the install and
//           build commands run, and the output folder is checked to exist.
//   stage 2  the web server the administrator chose, with a configuration written here, and the output folder copied in: nginx that does not run
//           as root (nginxinc/nginx-unprivileged, the default) or Caddy (run as a normal user, with its automatic HTTPS and admin port off).
//
// The commands run only inside the build, as a shell's RUN lines, never in the worker. They are one line each (the API and the database refuse
// anything else). The folder, the Node version and the port are the only other values written into the Dockerfile, and each is checked here again
// to a strict pattern: a bad row in the database must not turn into a Dockerfile instruction.
//
// Build variables are BuildKit secrets, as with Railpack: each is mounted only for the install and build steps and stored nowhere. A changed one does
// not re-run a cached step (Deploy without cache).
//
// The server refuses every dotfile and dot folder (.git, .env...), because serving the repository's own folder ("." as the output folder, with no
// build) would otherwise publish them. `.git` is also kept out of the build altogether (a `.dockerignore` next to the Dockerfile).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LABEL } from '@shipdok/shared';
import { dockerBuildEnvironment } from './buildenv.js';

export const DEFAULT_NODE_VERSION = '22';
export const SERVER_IMAGES = { nginx: 'nginxinc/nginx-unprivileged:1.29-alpine', caddy: 'caddy:2.10-alpine' };
export const SERVERS = Object.keys(SERVER_IMAGES);
const OUTPUT_RE = /^[A-Za-z0-9._/-]+$/;
const NODE_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$/;
const HTML_ROOT = { nginx: '/usr/share/nginx/html', caddy: '/srv' };

/** The folder as it is written into the Dockerfile: no leading ./ or trailing /, never absolute, never leaving the app's folder. '.' = the folder itself. */
export function cleanOutputDir(value) {
  const raw = value == null || value === '' ? '.' : String(value);
  if (!OUTPUT_RE.test(raw) || raw.startsWith('/') || raw.split('/').includes('..')) throw new Error('The output folder must be a relative path inside the app\'s folder');
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  return parts.length === 0 ? '.' : parts.join('/');
}

const checkPort = (port) => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('A static site listens on a port from 1024 up');
};

/** The Caddyfile, as the lines of a file. */
export function caddyfile({ port, spa }) {
  checkPort(port);
  return [
    '{',
    '  admin off',
    '  auto_https off',
    '}',
    `:${port} {`,
    `  root * ${HTML_ROOT.caddy}`,
    '  encode gzip',
    '  header X-Content-Type-Options nosniff',
    '  route {', // in THIS order: Caddy would otherwise run try_files first and the dotfile rule would see the rewritten address
    '    @dotfiles {', // .git, .env, .htaccess... (see the top of this file)
    '      path_regexp /\\.',
    '      not path /.well-known/*',
    '    }',
    '    respond @dotfiles 404',
    ...(spa ? ['    try_files {path} {path}/ /index.html'] : []),
    '    file_server',
    '  }',
    '}',
  ];
}

/** The nginx configuration, as the lines of a file. `spa`: an address with no file behind it shows index.html; otherwise it is a plain 404. */
export function serverConfig({ port, spa }) {
  checkPort(port);
  return [
    'server {',
    `  listen ${port};`,
    `  root ${HTML_ROOT.nginx};`,
    '  index index.html;',
    '  gzip on;',
    '  gzip_types text/css application/javascript application/json image/svg+xml text/plain application/xml;',
    '  add_header X-Content-Type-Options nosniff always;',
    '  location ~ /\\.(?!well-known/) { return 404; }', // .git, .env, .htaccess... (see the top of this file)
    `  location / { try_files $uri $uri/ ${spa ? '/index.html' : '=404'}; }`,
    '}',
  ];
}

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The Dockerfile text.
 * @param {object} o
 * @param {string|null} [o.installCommand]  / o.buildCommand  one line each; neither = no build stage, the folder is served as it is
 * @param {string|null} [o.outputDir]
 * @param {string|null} [o.nodeVersion]
 * @param {boolean} [o.spaFallback=true]
 * @param {'nginx'|'caddy'} [o.server='nginx']
 * @param {number} o.port
 * @param {string[]} [o.secretNames]  build variables, each mounted as a secret for the install and build steps
 */
export function staticDockerfile({ installCommand, buildCommand, outputDir, nodeVersion, spaFallback = true, server = 'nginx', port, secretNames = [] }) {
  if (!SERVERS.includes(server)) throw new Error('The web server must be nginx or caddy');
  const out = cleanOutputDir(outputDir);
  const node = nodeVersion || DEFAULT_NODE_VERSION;
  if (!NODE_RE.test(node)) throw new Error('The Node version must be a number such as 22, 20.11 or 18.20.4');
  for (const c of [installCommand, buildCommand]) {
    if (c && /[\u0000-\u001f\u007f]/.test(c)) throw new Error('A command must be a single line');
  }
  const mounts = secretNames.map((n) => `--mount=type=secret,id=${n},env=${n}`).join(' ');
  const run = (command) => `RUN ${mounts ? `${mounts} ` : ''}${command}`;
  const building = Boolean(installCommand || buildCommand);
  const lines = [];
  let from;
  if (building) {
    lines.push(
      `FROM node:${node}-bookworm-slim AS build`,
      'WORKDIR /src',
      'COPY . .',
      'RUN corepack enable', // yarn and pnpm commands work (npm is in the image already)
    );
    if (installCommand) lines.push(run(installCommand));
    if (buildCommand) lines.push(run(buildCommand));
    lines.push(`RUN test -d ${shellQuote(out)} || { echo "Shipdok: the output folder ${out} does not exist after the build (check the output folder setting)" >&2; exit 1; }`);
    from = `--from=build /src/${out}/`;
  } else {
    from = `${out}/`;
  }
  const html = HTML_ROOT[server];
  if (server === 'caddy') {
    lines.push(
      `FROM ${SERVER_IMAGES.caddy}`,
      'USER root',
      `RUN rm -rf ${html}/* && mkdir -p /etc/caddy && printf '%s\\n' ${caddyfile({ port, spa: spaFallback }).map(shellQuote).join(' ')} > /etc/caddy/Caddyfile`,
      `COPY ${from} ${html}/`,
      'ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config', // a normal user cannot write Caddy's usual folders
      'USER 1000',
      `EXPOSE ${port}`,
    );
  } else {
    lines.push(
      `FROM ${SERVER_IMAGES.nginx}`,
      'USER root',
      `RUN rm -rf ${html}/* && printf '%s\\n' ${serverConfig({ port, spa: spaFallback }).map(shellQuote).join(' ')} > /etc/nginx/conf.d/default.conf`,
      `COPY ${from} ${html}/`,
      `RUN chown -R nginx:nginx ${html}`,
      'USER nginx',
      `EXPOSE ${port}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Build the static site with `docker build`.
 * @param {object} eng
 * @param {object} o
 * @param {string} o.buildDir    the app's folder inside the clone (the build context)
 * @param {string} o.image
 * @param {Record<string,string>} o.labels  Shipdok's ownership labels; the build method is added here
 * @param {boolean} [o.noCache]
 * @param {string[]} [o.buildEnv] / o.buildSecretEnv  ['NAME=value']: with a static site every build variable is a secret
 * @param {number} o.containerPort
 */
export async function buildStatic(eng, { buildDir, image, labels = {}, noCache, buildEnv = [], buildSecretEnv = [], installCommand, buildCommand, outputDir, nodeVersion, spaFallback = true, server = 'nginx', containerPort, signal, sink, log, baseEnv = process.env }) {
  const build = dockerBuildEnvironment([], [...buildEnv, ...buildSecretEnv], baseEnv); // throws, naming the variable, if a name cannot be used
  const building = Boolean(installCommand || buildCommand);
  const text = staticDockerfile({ installCommand, buildCommand, outputDir, nodeVersion, spaFallback, server, port: containerPort, secretNames: building ? build.secretNames : [] });
  if (build.secretNames.length && building) log(`Build variables passed as build secrets: ${build.secretNames.join(', ')} (a changed one does not re-run a cached step, use Deploy without cache)`);
  if (build.secretNames.length && !building) log('Build variables are not used: with no install or build command there is no build step');
  log(building
    ? `Static site: building with Node ${nodeVersion || DEFAULT_NODE_VERSION}, serving ${cleanOutputDir(outputDir)} with ${server} on port ${containerPort}`
    : `Static site: serving ${cleanOutputDir(outputDir)} with ${server} on port ${containerPort} (no build command)`);
  const dir = await mkdtemp(join(tmpdir(), 'shipdok-static-')); // outside the clone: the repository cannot replace the Dockerfile
  try {
    const file = join(dir, 'static.Dockerfile');
    await writeFile(file, text);
    await writeFile(`${file}.dockerignore`, '.git\n');
    log(noCache === true ? `Building ${image} without the build cache` : `Building ${image}`);
    await eng.run('docker', [
      'build', '--progress=plain', '-t', image,
      ...(noCache === true ? ['--no-cache'] : []),
      ...Object.entries({ ...labels, [LABEL.method]: 'static' }).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      ...build.args,
      '-f', file,
      buildDir,
    ], { env: build.env, signal, sink });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
