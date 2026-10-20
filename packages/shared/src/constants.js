// Names both the API and the worker must agree on. Keep them here, not copied into each app.
export const DEPLOY_QUEUE = 'deploy';

// Docker ownership labels. Every lookup and cleanup filters on these.
export const LABEL = {
  managed: 'shipdok.managed',
  app: 'shipdok.app-id',
  deployment: 'shipdok.deployment-id',
  role: 'shipdok.role', // candidate | live
};

// ---- Application environment variables ----
// Must match the CHECK constraint in migration 003.
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_ENV_VARS = 100;
export const MAX_ENV_VALUE_BYTES = 64 * 1024;

// Names an app may not set: overriding these inside a container can change how the
// process loads code or finds binaries, or collides with Shipdok's own settings.
const RESERVED = new Set([
  'PATH', 'HOME', 'USER', 'HOSTNAME', 'SHELL', 'PWD',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'NODE_OPTIONS', 'DOCKER_HOST',
]);
export const isReservedEnvName = (name) => RESERVED.has(name) || name.startsWith('SHIPDOK_');

// Where a variable is available. Must match the CHECK constraint in migration 023.
export const ENV_SCOPES = ['runtime', 'build', 'both'];
export const reachesBuild = (scope) => scope === 'build' || scope === 'both';
export const reachesRuntime = (scope) => scope === 'runtime' || scope === 'both';

// How a variable that reaches the build is given to `docker build`: a build argument or a BuildKit secret. Must match the CHECK constraint in migration 024.
export const BUILD_PASSES = ['arg', 'secret'];

// A build variable is handed to `docker build --build-arg NAME`, which reads the value from the environment of the docker command itself.
// So a name must not be one that changes how that command (or the BuildKit client) behaves.
const BUILD_RESERVED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'PWD', 'LANG', 'TZ']);
const BUILD_RESERVED_PREFIXES = ['LD_', 'DOCKER_', 'BUILDKIT_', 'BUILDX_', 'COMPOSE_', 'XDG_', 'LC_'];
export const isReservedBuildName = (name) => BUILD_RESERVED.has(name) || BUILD_RESERVED_PREFIXES.some((p) => name.startsWith(p));

// A GitHub "owner/repo". Dots are legal inside names, but `.` and `..` alone are path segments: left in, a name
// like `o/..` or `../x` would be normalised away inside a URL. Rejected here, once, for everything that uses it.
export const REPO_FULL_NAME_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
