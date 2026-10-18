// Getting the source code: clone a branch head, or fetch one exact commit.
// Takes the engine as a parameter so tests can run it against a fake OR against real git and a real HTTP server.
//
// The GitHub token (if any) reaches git ONLY through its environment, never through arguments (visible to every
// user via `ps`), never inside a URL, and never written to the checkout's .git/config.

// The only variables git gets from the worker's own environment. Everything else (APP_SECRETS_KEY, database
// and Redis passwords, the GitHub App key...) is deliberately NOT passed to a process that talks to the network
// and reads untrusted repository data.
const PASS_THROUGH = [
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

export function gitEnvironment(extra = {}, base = process.env) {
  const env = {};
  for (const key of PASS_THROUGH) if (base[key] !== undefined) env[key] = base[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra }; // never wait for a password nobody can type
}

/**
 * @returns {Promise<string>} the commit that was actually checked out
 */
export async function checkoutSource(eng, { workDir, repo, ref, commit, env, signal, log = () => {} }) {
  const opts = { signal, env };
  if (commit) {
    // Build EXACTLY the pushed commit, not whatever the branch points to by now (a second push may have landed).
    log(`Fetching commit ${commit.slice(0, 7)} of ${repo}`);
    await eng.run('git', ['-C', workDir, 'init', '-q'], opts);
    await eng.run('git', ['-C', workDir, 'remote', 'add', 'origin', repo], opts);
    // `--` means the commit can never be read as an option, even if the validation upstream were ever loosened.
    await eng.run('git', ['-C', workDir, 'fetch', '-q', '--depth', '1', 'origin', '--', commit], opts);
    await eng.run('git', ['-C', workDir, 'checkout', '-q', 'FETCH_HEAD'], opts);
  } else {
    log(`Cloning ${repo}@${ref}`);
    await eng.run('git', ['clone', '--depth', '1', '--branch', ref, repo, workDir], opts);
  }
  const head = await eng.capture('git', ['-C', workDir, 'rev-parse', 'HEAD'], { env });
  if (commit && head !== commit) throw new Error('The checked-out commit does not match the requested one');
  return head;
}
