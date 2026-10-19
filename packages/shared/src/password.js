export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

// "aaaaaaaaaaaa", "abababababab", "x7Kx7Kx7Kx7K": the whole password is one short unit repeated.
function isRepetition(password) {
  for (let unit = 1; unit <= 4; unit++) {
    if (password.length % unit === 0 && password === password.slice(0, unit).repeat(password.length / unit)) return true;
  }
  return false;
}

// "123456789012", "987654321098", "abcdefghijkl": every character is the next (or previous) one in the character set.
function isSequence(password) {
  const step = password.charCodeAt(1) - password.charCodeAt(0);
  if (Math.abs(step) !== 1) return false;
  for (let i = 1; i < password.length; i++) if (password.charCodeAt(i) - password.charCodeAt(i - 1) !== step) return false;
  return true;
}

// Digits counting up or down and wrapping round: "123456789012", "890123456789".
function isDigitCycle(password) {
  if (!/^\d+$/.test(password)) return false;
  const digits = [...password].map(Number);
  const up = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10);
  const down = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10);
  return up || down;
}

/** Why a password is not acceptable, in words for the administrator, or null when it is. */
export function passwordProblem(password, { username } = {}) {
  if (typeof password !== 'string') return 'Give a password';
  if (password.length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `The password can be at most ${PASSWORD_MAX} characters`;
  if (isRepetition(password)) return 'The password is a short pattern repeated over and over';
  if (isSequence(password) || isDigitCycle(password)) return 'The password is a simple sequence of characters';
  if (typeof username === 'string' && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
    return 'The password must not contain the username';
  }
  return null;
}
