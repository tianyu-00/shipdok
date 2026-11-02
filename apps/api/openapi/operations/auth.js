import { op, route, ok, ref, json } from '../helpers.js';

const TAG = 'Account';
const nothing = (description) => ({ description });

export default Object.fromEntries([
  route('GET', '/api/auth/status', op({
    tag: TAG, auth: 'none', summary: 'Is there an administrator, and is this browser signed in?',
    description: 'The first thing the dashboard asks. Safe to call without signing in. The setup token itself is never sent; `setupTokenRequired` only says whether the setup screen must ask for it.',
    responses: { 200: ok('The state.', ref('AuthStatus')) },
  })),
  route('POST', '/api/auth/setup', op({
    tag: TAG, auth: 'none', summary: 'Create the administrator (first run only)',
    description: 'Creates the one administrator account, signs this browser in, and returns the ten recovery codes **once**. Works only while no administrator exists (a second call is 409). While the platform has a setup token (printed in the API log), it must be sent as `setupToken`. The password must pass the password rules.',
    body: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string' }, setupToken: { type: 'string', description: 'The setup token from the API log; needed while `setupTokenRequired` is true.' } } },
    responses: { 201: ok('Created and signed in.', ref('SetupResult')) },
    errors: { 400: 'The name or the password does not pass the rules (`error` says which).', 403: 'The setup token is missing or wrong.', 409: 'An administrator already exists.', 429: 'Too many tries from this address.' },
  })),
  route('POST', '/api/auth/login', op({
    tag: TAG, auth: 'none', summary: 'Sign in',
    description: 'Sets the session cookie `shipdok.sid`. Failed tries are counted per name and per address: after five in a row the next ones are refused (429 `locked`) for 30 seconds, doubling, up to 15 minutes per name and 60 per address. While locked even the right password is refused.',
    body: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string' } } },
    responses: { 200: ok('Signed in.', ref('Username')) },
    errors: { 400: 'Username or password missing.', 401: 'Wrong name or password (the same answer for an unknown name).', 429: 'Locked for a while; see the description.' },
  })),
  route('POST', '/api/auth/logout', op({
    tag: TAG, auth: 'none', summary: 'Sign out this browser',
    description: 'Ends this session and clears the cookie.', responses: { 204: nothing('Signed out.') },
  })),
  route('POST', '/api/auth/logout-all', op({
    tag: TAG, summary: 'Sign out every browser and device',
    description: 'Ends every session of the administrator, this one included.', responses: { 204: nothing('Signed out everywhere.') },
  })),
  route('GET', '/api/auth/me', op({
    tag: TAG, summary: 'Who is signed in?', description: 'The administrator\'s name; also a cheap way to check the session is still valid.',
    responses: { 200: ok('The signed-in administrator.', ref('Username')) },
  })),
  route('GET', '/api/auth/logins', op({
    tag: TAG, summary: 'Sign-ins and activity',
    description: 'The sign-in attempts and the things done with the password, good and bad (names typed by strangers included), newest first. Kinds: `login`, `setup`, `recovery`, `reset` (a password reset on the machine) are sign-ins; `settings` (public access changed), `github` (GitHub connected or changed), `backup` (backup passphrase), `download` (a backup downloaded), `restore` (a restore or reclaim asked for), `logsettings` (how long this log is kept) are activity.',
    parameters: [
      { name: 'limit', in: 'query', required: false, description: 'How many, 1 to 500 (default 20).', schema: { type: 'integer', minimum: 1, maximum: 500, default: 20 } },
      { name: 'scope', in: 'query', required: false, description: '`signins` for the sign-in kinds only, `activity` for the others only; left out, both.', schema: { type: 'string', enum: ['signins', 'activity'] } },
    ],
    responses: { 200: ok('The attempts, and for how many days rows are kept.', { type: 'object', required: ['logins', 'keepDays'], properties: { logins: { type: 'array', items: ref('LoginAttempt') }, keepDays: { type: 'integer', description: '7, 30 (the default), 90 or 365.' } } }) },
    errors: { 400: '`scope` is not `signins` or `activity`.' },
  })),
  route('PUT', '/api/auth/logins/settings', op({
    tag: TAG, summary: 'How long sign-ins and activity are kept',
    description: 'Needs a session AND the password: a shorter time deletes older rows at once. Rows older than the chosen number of days are removed now and whenever something new is recorded. The change is recorded as `logsettings`. A wrong password is a **403** (`wrong_password`). Limited to 10 tries per 15 minutes.',
    body: { type: 'object', required: ['password', 'keepDays'], properties: { password: { type: 'string' }, keepDays: { type: 'integer', enum: [7, 30, 90, 365] } } },
    responses: { 200: ok('Saved.', { type: 'object', required: ['keepDays'], properties: { keepDays: { type: 'integer' } } }) },
    errors: { 400: 'No password, or `keepDays` is not one of the choices.', 403: 'The password is wrong (`code: wrong_password`) or the Origin is not allowed.', 429: 'Too many tries.' },
  })),
  route('POST', '/api/auth/password', op({
    tag: TAG, summary: 'Change the password',
    description: 'Needs a session AND the current password. Every other session ends and this one gets a new id. A wrong current password is a **403** (`wrong_password`), not a 401, so a client does not mistake it for an ended session. Limited to 10 tries per 15 minutes.',
    body: { type: 'object', required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', description: 'Must pass the password rules and differ from the current one.' } } },
    responses: { 204: nothing('Changed.') },
    errors: { 400: 'Missing fields, a weak new password (`code: weak_password`), or the same as the current one.', 403: 'The current password is wrong (`code: wrong_password`) or the Origin is not allowed.', 429: 'Too many tries.' },
  })),
  route('GET', '/api/auth/recovery', op({
    tag: TAG, summary: 'How many recovery codes are left',
    description: 'Never the codes themselves: they exist in the clear only at the moment they are made.',
    responses: { 200: ok('The count.', ref('RecoveryStatus')) },
  })),
  route('POST', '/api/auth/recovery', op({
    tag: TAG, summary: 'Make a new set of recovery codes',
    description: 'Replaces the whole set (the old codes stop working) and returns the ten new ones **once**. Needs the current password.',
    body: ref('PasswordOnly'),
    responses: { 200: ok('The new codes.', { type: 'object', required: ['codes'], properties: { codes: { type: 'array', items: { type: 'string' } } } }) },
    errors: [400, 403, 429],
  })),
  route('POST', '/api/auth/recover', op({
    tag: TAG, auth: 'none', summary: 'Set a new password with a recovery code',
    description: 'For a lost password: the name, one recovery code and a new password. A weak new password is refused BEFORE the code is looked at, so that answer says nothing about the code and does not use it up. A good code is spent (single use), the password is set, every session ends and this browser is signed in. Wrong code, used code and unknown name all give the same 401. Tries share the sign-in lockout.',
    body: { type: 'object', required: ['username', 'code', 'newPassword'], properties: { username: { type: 'string' }, code: { type: 'string', description: 'A recovery code; case, spaces and dashes do not matter.' }, newPassword: { type: 'string' } } },
    responses: { 200: ok('Signed in with the new password.', ref('Username')) },
    errors: { 400: 'Missing fields, or the new password does not pass the rules (`code: weak_password`).', 401: 'Wrong name or code.', 429: 'Locked for a while.' },
  })),
]);
