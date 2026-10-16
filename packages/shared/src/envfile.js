// Parser for .env text, with line-numbered problems.
//
// Supported: blank lines, # comments, `export KEY=value`, unquoted values (a "#" starts a comment only
// when preceded by whitespace), 'single quoted' (literal) and "double quoted" (\n \r \t \" \\ escapes)
// values with an optional trailing comment. Duplicate keys: the last one wins.
// Not supported: multi-line values (use \n inside double quotes).
//
// Problem messages never echo line content: a malformed line may be a secret.
import { ENV_KEY_RE } from './constants.js';

const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

// `rest` starts just after the opening quote. Returns { value, end } (end = index after the closing quote) or null.
function readQuoted(rest, quote) {
  let value = '';
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote === '"' && ch === '\\' && i + 1 < rest.length && rest[i + 1] in ESCAPES) {
      value += ESCAPES[rest[i + 1]];
      i++;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
  }
  return null;
}

export function parseEnvText(text) {
  const byKey = new Map();
  const duplicates = new Set();
  const problems = [];

  String(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    let s = raw.trim();
    if (!s || s.startsWith('#')) return;
    s = s.replace(/^export\s+/, '');

    const eq = s.indexOf('=');
    if (eq === -1) return void problems.push({ line, message: 'Expected KEY=VALUE' });
    const key = s.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) return void problems.push({ line, message: 'Invalid variable name' });

    const afterEq = s.slice(eq + 1);
    const rest = afterEq.trimStart();
    let value;
    if (rest[0] === '"' || rest[0] === "'") {
      const q = readQuoted(rest.slice(1), rest[0]);
      if (!q) {
        return void problems.push({ line, message: 'Unterminated quoted value (multi-line values are not supported; use \\n inside double quotes)' });
      }
      const tail = rest.slice(1 + q.end).trim();
      if (tail && !tail.startsWith('#')) return void problems.push({ line, message: 'Unexpected text after the closing quote' });
      value = q.value;
    } else {
      const comment = afterEq.search(/\s#/);
      value = (comment === -1 ? afterEq : afterEq.slice(0, comment)).trim();
    }
    if (value.includes('\0')) return void problems.push({ line, message: 'Value contains a null character' });

    if (byKey.has(key)) duplicates.add(key);
    byKey.set(key, { key, value, line });
  });

  return { vars: [...byKey.values()], problems, duplicates: [...duplicates] };
}
