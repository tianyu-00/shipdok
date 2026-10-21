// Building an app with Railpack instead of its own Dockerfile.
//
// Railpack looks at the code (Node, Python, Go, a static site...) and writes a BUILD PLAN. Shipdok does not use Railpack's own `build` command: it
// takes the plan and runs the same `docker build` as for a Dockerfile, with Railpack's BuildKit frontend reading the plan instead of a Dockerfile.
// So the build cache, the time limit, cancelling, the log, the labels and the secrets all work as they always did.
//
//   1. `railpack prepare DIR --plan-out PLAN`   (a program of ours, in the worker; it only LOOKS at the code and writes the plan)
//   2. `docker build --build-arg BUILDKIT_SYNTAX=<frontend> -f PLAN DIR`   (the install and build commands run here, inside BuildKit, like a Dockerfile's RUN)
//
// Labels: Railpack's frontend ignores `docker build --label`, and Shipdok finds an app's images by their labels (rollback, clean-up, the Storage page). So
// after the build a second, instant `docker build` (FROM the image, LABEL ...) adds them. It copies no data: the layers are shared. The first build
// is tagged with a temporary name that is removed afterwards: re-using the final tag would leave the unlabelled image behind as an untagged image
// that a later `docker rmi` of the labelled one does not remove (checked on Docker's classic image store), a leak of the whole image every time.
//
// Variables: the plan only needs to know a variable's NAME (it lists it under `secrets`), never its value, and `prepare` only takes values on its
// command line, which is where a secret must never be. So `prepare` gets a placeholder and the real value reaches the build as a BuildKit secret,
// exactly like a build secret of a Dockerfile app (docker's own environment, never an argument, never stored in the image). The consequence: a
// variable cannot change WHAT the plan is (the Node version, the output directory...). That belongs in the repository (package.json, .node-version,
// railpack.json). The install command is the exception that needs a value: it is the administrator's own setting, not a secret, and Railpack
// reads it from a variable named RAILPACK_INSTALL_CMD, which it then also lists as a secret, so it is handed to the build the same way.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LABEL } from '@shipdok/shared';
import { dockerBuildEnvironment, passThroughEnvironment } from './buildenv.js';

export const FRONTEND_IMAGE = 'ghcr.io/railwayapp/railpack-frontend';
export const INSTALL_VARIABLE = 'RAILPACK_INSTALL_CMD';
export const PLACEHOLDER = 'x'; // what `prepare` is told a variable's value is (it must not be empty: an empty value is ignored)
const VERSION_RE = /\b(\d+\.\d+\.\d+)\b/;

/** A Dockerfile that only adds labels to an existing image. Values are written as JSON strings; one with a line break would be a bug, so it is refused. */
export function labelDockerfile(image, labels) {
  const parts = Object.entries(labels).map(([k, v]) => {
    if (/[\u0000-\u001f\u007f]/.test(`${k}${v}`)) throw new Error('A label cannot contain a line break or other control character');
    return `${JSON.stringify(k)}=${JSON.stringify(String(v))}`;
  });
  return `FROM ${image}\nLABEL ${parts.join(' ')}\n`;
}

/** `railpack --version` prints "railpack version 0.43.0". The frontend image must be the same version as the program that wrote the plan. */
export function parseRailpackVersion(output) {
  const m = VERSION_RE.exec(String(output ?? ''));
  if (!m) throw new Error('Could not tell which version of Railpack is installed in the worker');
  return m[1];
}

/** Variables named RAILPACK_... configure Railpack itself. They cannot work as build variables (see above), so they are not passed to it. */
export const isRailpackSetting = (name) => name.startsWith('RAILPACK_');

/**
 * Splits the app's build variables into the ones that go to the build and the RAILPACK_ ones that cannot.
 * @param {string[]} pairs ['NAME=value', ...] (build arguments and build secrets together: with Railpack every build variable is a secret)
 */
export function railpackVariables(pairs = []) {
  const nameOf = (pair) => (pair.includes('=') ? pair.slice(0, pair.indexOf('=')) : pair);
  return {
    used: pairs.filter((pair) => !isRailpackSetting(nameOf(pair))),
    skipped: pairs.map(nameOf).filter(isRailpackSetting),
  };
}

/** The `railpack prepare` command line. Only NAMES of variables appear in it, with a placeholder value, plus the administrator's own commands. */
export function prepareArguments({ dir, planFile, names = [], installCommand, buildCommand, startCommand }) {
  return [
    'prepare', dir, '--plan-out', planFile,
    '--error-missing-start', // no way found to start the app: fail now, with Railpack's own explanation, not with a container that exits
    ...names.flatMap((n) => ['--env', `${n}=${PLACEHOLDER}`]),
    ...(installCommand ? ['--env', `${INSTALL_VARIABLE}=${installCommand}`] : []),
    ...(buildCommand ? ['--build-cmd', buildCommand] : []),
    ...(startCommand ? ['--start-cmd', startCommand] : []),
  ];
}

/**
 * Plan the build with Railpack, then build the plan with `docker build`.
 * @param {object} eng        the engine (run, capture)
 * @param {object} o
 * @param {string} o.buildDir        the folder to build (inside the clone)
 * @param {string} o.image           the tag to build
 * @param {Record<string,string>} o.labels  Shipdok's labels for the image (ownership); the build method is added here
 * @param {boolean} [o.noCache]
 * @param {string[]} [o.buildEnv]    the app's build variables as ['NAME=value'] that were to be build arguments
 * @param {string[]} [o.buildSecretEnv]  the ones that were to be build secrets (with Railpack both are secrets)
 * @param {string} [o.installCommand] / o.buildCommand / o.startCommand  the administrator's overrides (empty: Railpack decides)
 */
export async function buildWithRailpack(eng, { buildDir, image, labels = {}, noCache, buildEnv = [], buildSecretEnv = [], installCommand, buildCommand, startCommand, signal, sink, log, baseEnv = process.env }) {
  let versionText;
  try {
    versionText = await eng.capture('railpack', ['--version'], { env: passThroughEnvironment(baseEnv) });
  } catch (err) {
    throw new Error(err?.code === 'ENOENT' ? 'Railpack is not installed in the worker (the published worker image has it)' : `Could not run Railpack: ${err.message}`);
  }
  const version = parseRailpackVersion(versionText);
  const { used, skipped } = railpackVariables([...buildEnv, ...buildSecretEnv]);
  if (skipped.length) log(`Not passed to the build: ${skipped.join(', ')} (variables named RAILPACK_... configure Railpack and cannot be set here; use the install, build and start commands, or a railpack.json in the repository)`);
  // (A variable can never collide with the install command: RAILPACK_ names were taken out above.)
  const secretPairs = [...(installCommand ? [`${INSTALL_VARIABLE}=${installCommand}`] : []), ...used];
  const build = dockerBuildEnvironment([], secretPairs, baseEnv); // throws, naming the variable, if a name cannot be used
  const names = build.secretNames.filter((n) => n !== INSTALL_VARIABLE);
  if (names.length) log(`Build variables passed as build secrets: ${names.join(', ')} (with Railpack every build variable is a secret; a changed one does not re-run a cached step, use Deploy without cache)`);

  const unlabelled = `${image}-unlabelled`; // the first build's tag; always removed again (see the top of this file)
  const planDir = await mkdtemp(join(tmpdir(), 'shipdok-plan-')); // outside the clone: the plan is not part of what is built
  const planFile = join(planDir, 'railpack-plan.json');
  try {
    log(`Planning the build with Railpack ${version}`);
    try {
      await eng.run('railpack', prepareArguments({ dir: buildDir, planFile, names, installCommand, buildCommand, startCommand }), { env: passThroughEnvironment(baseEnv), signal, sink });
    } catch (err) {
      if (eng.isAbort?.(err) || signal?.aborted) throw err; // a cancel or the time limit is reported as what it is
      throw new Error('Railpack could not plan the build (its reason is in the build log)');
    }
    log(noCache === true ? `Building ${image} without the build cache` : `Building ${image}`);
    await eng.run('docker', [
      'build', '--progress=plain', '-t', unlabelled,
      ...(noCache === true ? ['--no-cache'] : []),
      '--build-arg', `BUILDKIT_SYNTAX=${FRONTEND_IMAGE}:v${version}`,
      ...build.args,
      '-f', planFile,
      buildDir,
    ], { env: build.env, signal, sink });

    // The ownership labels (see the top of this file).
    const labelFile = join(planDir, 'labels.Dockerfile');
    await writeFile(labelFile, labelDockerfile(unlabelled, { ...labels, [LABEL.method]: 'railpack' }));
    await eng.run('docker', ['build', '--progress=plain', '-t', image, '-f', labelFile, planDir], { env: passThroughEnvironment(baseEnv), signal, sink });
  } finally {
    await eng.removeImage(unlabelled); // (quietly: it is gone already when the build did not get that far)
    await rm(planDir, { recursive: true, force: true });
  }
}
