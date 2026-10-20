import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvText, isReservedEnvName, isReservedBuildName, reachesBuild, reachesRuntime, ENV_SCOPES } from '../src/index.js';

const parse = (t) => parseEnvText(t);
const asObject = (r) => Object.fromEntries(r.vars.map((v) => [v.key, v.value]));

describe('parseEnvText: accepted syntax', () => {
  test('plain KEY=VALUE, blank lines and comments', () => {
    const r = parse('# a comment\n\nA=1\n  B = 2  \n#C=3\n');
    assert.deepEqual(asObject(r), { A: '1', B: '2' });
    assert.deepEqual(r.problems, []);
  });

  test('export prefix, CRLF line endings and a BOM', () => {
    const r = parse('\uFEFFexport A=1\r\nexport   B=2\r\n');
    assert.deepEqual(asObject(r), { A: '1', B: '2' });
  });

  test('empty values', () => {
    assert.deepEqual(asObject(parse('A=\nB=""\nC=\'\'\nD=   ')), { A: '', B: '', C: '', D: '' });
  });

  test('double quotes: spaces, escapes, # and = inside', () => {
    const r = parse('A="hello world"\nB="line1\\nline2\\ttab"\nC="quote \\" and \\\\ backslash"\nD="a#b=c"');
    assert.deepEqual(asObject(r), {
      A: 'hello world',
      B: 'line1\nline2\ttab',
      C: 'quote " and \\ backslash',
      D: 'a#b=c',
    });
  });

  test('single quotes are literal (no escapes)', () => {
    assert.deepEqual(asObject(parse("A='raw \\n stays # too'")), { A: 'raw \\n stays # too' });
  });

  test('an unknown escape in double quotes keeps the backslash', () => {
    assert.deepEqual(asObject(parse('A="C:\\path\\x"')), { A: 'C:\\path\\x' });
  });

  test('values containing = and : (connection strings)', () => {
    const r = parse('DATABASE_URL=postgres://u:p%40ss@host:5432/db?sslmode=require&x=y');
    assert.equal(asObject(r).DATABASE_URL, 'postgres://u:p%40ss@host:5432/db?sslmode=require&x=y');
  });

  test('# starts a comment only after whitespace', () => {
    const r = parse('A=abc#def\nB=abc #comment\nC="q" # note\nD= #just a comment');
    assert.deepEqual(asObject(r), { A: 'abc#def', B: 'abc', C: 'q', D: '' });
  });

  test('duplicate keys: the last one wins and is reported', () => {
    const r = parse('A=1\nB=2\nA=3');
    assert.deepEqual(asObject(r), { A: '3', B: '2' });
    assert.deepEqual(r.duplicates, ['A']);
    assert.equal(r.vars.find((v) => v.key === 'A').line, 3);
  });
});

describe('parseEnvText: problems carry line numbers and never echo content', () => {
  const secret = 'hunter2-should-never-appear';

  test('reports every bad line, not just the first, and keeps the good ones', () => {
    const r = parse(`GOOD=1\nno equals sign ${secret}\n1BAD=x\nA B=${secret}\nOK=2\n"unterminated`);
    assert.deepEqual(r.problems.map((p) => p.line), [2, 3, 4, 6]);
    assert.deepEqual(r.vars.map((v) => v.key), ['GOOD', 'OK']);
  });

  test('messages are generic', () => {
    const r = parse(`${secret}\nA="${secret}\nB="x" ${secret}\n-bad-=${secret}`);
    assert.equal(r.problems.length, 4);
    for (const p of r.problems) assert.ok(!p.message.includes(secret), p.message);
    assert.match(r.problems[0].message, /KEY=VALUE/);
    assert.match(r.problems[1].message, /Unterminated/);
    assert.match(r.problems[2].message, /closing quote/);
    assert.match(r.problems[3].message, /variable name/);
  });

  test('a multi-line quoted value is a clear error, not a silent truncation', () => {
    const r = parse('KEY="line one\nline two"');
    assert.ok(r.problems.some((p) => p.line === 1 && /multi-line/.test(p.message)));
  });

  test('rejects null characters in values', () => {
    assert.equal(parse('A=ab\u0000cd').problems.length, 1);
  });

  test('empty input and comment-only input produce nothing', () => {
    for (const t of ['', '\n\n', '# only a comment\n']) {
      const r = parse(t);
      assert.deepEqual([r.vars, r.problems, r.duplicates], [[], [], []]);
    }
  });
});

describe('isReservedEnvName', () => {
  test('flags names that could change how a container runs', () => {
    for (const n of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'HOME', 'SHIPDOK_ANYTHING']) assert.ok(isReservedEnvName(n), n);
  });
  test('allows ordinary names', () => {
    for (const n of ['DATABASE_URL', 'PORT', 'NODE_ENV', 'API_KEY', 'path', 'SHIPDOKX']) assert.ok(!isReservedEnvName(n), n);
  });
});

describe('where a variable is available', () => {
  test('the scopes are runtime, build and both', () => assert.deepEqual(ENV_SCOPES, ['runtime', 'build', 'both']));
  test('runtime reaches the container only, build the build only, both reaches both', () => {
    assert.deepEqual(ENV_SCOPES.map((s) => [reachesRuntime(s), reachesBuild(s)]), [[true, false], [false, true], [true, true]]);
  });
  test('anything else reaches nowhere (never by accident)', () => {
    for (const s of [undefined, null, '', 'Build', 'all']) assert.deepEqual([reachesRuntime(s), reachesBuild(s)], [false, false], String(s));
  });
});

describe('isReservedBuildName', () => {
  test('names that change how docker build runs are reserved', () => {
    for (const n of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LD_PRELOAD', 'DOCKER_HOST', 'DOCKER_CONFIG', 'BUILDKIT_PROGRESS', 'BUILDX_BUILDER', 'COMPOSE_FILE', 'XDG_CONFIG_HOME', 'LC_ALL', 'LANG']) assert.ok(isReservedBuildName(n), n);
  });
  test('ordinary build variables are not', () => {
    for (const n of ['VITE_API_URL', 'NEXT_PUBLIC_KEY', 'NODE_ENV', 'NPM_TOKEN', 'HTTP_PROXY', 'APP_VERSION', 'MYDOCKER_X']) assert.ok(!isReservedBuildName(n), n);
  });
});
