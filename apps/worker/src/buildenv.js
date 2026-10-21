// What `docker build` is given for the app's build-time variables.
//
// A value never goes on the command line (every user on the machine can read arguments with `ps`). `--build-arg NAME` with no value
// makes the docker command read NAME from ITS OWN environment, so the values travel there. That environment is built here from a short
// list instead of the worker's whole one (which holds APP_SECRETS_KEY, the database and Redis passwords...), so the only secrets docker
// sees are the build variables the administrator chose.
//
// A variable can reach the build in two ways. As a build ARGUMENT (`--build-arg NAME`) a Dockerfile that declares `ARG NAME` can use it, and if
// it does the value is stored in the image's history. As a build SECRET (`--secret id=NAME,env=NAME`) BuildKit mounts it only for the RUN step
// that asks for it (`RUN --mount=type=secret,id=NAME,env=NAME ...`) and nothing of it is stored. Both read the value from docker's environment.
import { ENV_KEY_RE, isReservedEnvName, isReservedBuildName } from '@shipdok/shared';

// What the docker command needs from the worker's own environment: finding itself and its plugins, its configuration, the daemon, proxies.
const PASS_THROUGH = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];
const PASS_THROUGH_PREFIXES = ['DOCKER_', 'BUILDKIT_', 'BUILDX_', 'XDG_'];

/** The few variables of the worker's own environment that a child command needs (see the list above); everything else, secrets included, is left out. */
export function passThroughEnvironment(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (PASS_THROUGH.includes(key) || PASS_THROUGH_PREFIXES.some((p) => key.startsWith(p)))) env[key] = value;
  }
  return env;
}

/**
 * @param {string[]} buildEnv        ['NAME=value', ...] passed as build arguments
 * @param {string[]} buildSecretEnv  ['NAME=value', ...] passed as build secrets
 * @returns {{ args: string[], names: string[], secretNames: string[], env: Record<string,string> }}
 *   args: ['--build-arg', 'NAME', ..., '--secret', 'id=NAME,env=NAME', ...] (no values); names / secretNames: the variables of each kind; env: for the docker command
 * Throws (naming the variable, never its value) if a name cannot be used: the API refuses these, so this only guards against a bad row.
 */
export function dockerBuildEnvironment(buildEnv = [], buildSecretEnv = [], base = process.env) {
  const env = passThroughEnvironment(base);
  env.DOCKER_BUILDKIT = '1';
  const args = [];
  const names = [];
  const secretNames = [];
  const seen = new Set();
  const add = (pair, list, flags) => {
    const i = pair.indexOf('=');
    const name = i < 0 ? pair : pair.slice(0, i);
    if (!ENV_KEY_RE.test(name) || isReservedEnvName(name) || isReservedBuildName(name)) {
      throw new Error(`The variable "${name}" cannot be used at build time`);
    }
    if (seen.has(name)) return;
    seen.add(name);
    env[name] = pair.slice(i + 1);
    list.push(name);
    args.push(...flags(name));
  };
  for (const pair of buildEnv) add(pair, names, (n) => ['--build-arg', n]);
  for (const pair of buildSecretEnv) add(pair, secretNames, (n) => ['--secret', `id=${n},env=${n}`]);
  return { args, names, secretNames, env };
}
