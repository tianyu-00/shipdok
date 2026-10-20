// What `docker build` is given for the app's build-time variables.
//
// A value never goes on the command line (every user on the machine can read arguments with `ps`). `--build-arg NAME` with no value
// makes the docker command read NAME from ITS OWN environment, so the values travel there. That environment is built here from a short
// list instead of the worker's whole one (which holds APP_SECRETS_KEY, the database and Redis passwords...), so the only secrets docker
// sees are the build variables the administrator chose.
import { ENV_KEY_RE, isReservedEnvName, isReservedBuildName } from '@shipdok/shared';

// What the docker command needs from the worker's own environment: finding itself and its plugins, its configuration, the daemon, proxies.
const PASS_THROUGH = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];
const PASS_THROUGH_PREFIXES = ['DOCKER_', 'BUILDKIT_', 'BUILDX_', 'XDG_'];

/**
 * @param {string[]} buildEnv  ['NAME=value', ...] (scope build or both)
 * @returns {{ args: string[], env: Record<string,string> }}  args: ['--build-arg', 'NAME', ...] (no values); env: for the docker command
 * Throws (naming the variable, never its value) if a name cannot be used: the API refuses these, so this only guards against a bad row.
 */
export function dockerBuildEnvironment(buildEnv = [], base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (PASS_THROUGH.includes(key) || PASS_THROUGH_PREFIXES.some((p) => key.startsWith(p)))) env[key] = value;
  }
  env.DOCKER_BUILDKIT = '1';
  const args = [];
  const seen = new Set();
  for (const pair of buildEnv) {
    const i = pair.indexOf('=');
    const name = i < 0 ? pair : pair.slice(0, i);
    if (!ENV_KEY_RE.test(name) || isReservedEnvName(name) || isReservedBuildName(name)) {
      throw new Error(`The variable "${name}" cannot be used at build time`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    env[name] = pair.slice(i + 1);
    args.push('--build-arg', name);
  }
  return { args, env };
}
