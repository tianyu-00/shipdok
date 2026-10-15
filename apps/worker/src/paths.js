// Root-directory safety for untrusted repositories.
import { realpath } from "node:fs/promises";
import { resolve, sep, posix, isAbsolute } from "node:path";

const OUTSIDE = "Root directory must be inside the repository";

// Cheap lexical check, safe to run before anything touches disk or Docker.
export function assertRelativeDir(dir) {
  const n = posix.normalize(dir);
  if (isAbsolute(dir) || n === ".." || n.startsWith("../")) throw new Error(OUTSIDE);
}

// After cloning: resolve symlinks and confirm the build context really is inside the clone.
// A repo can contain `backend -> /`, which passes the lexical check but would hand Docker the host root.
export async function resolveBuildDir(workDir, dir) {
  assertRelativeDir(dir);
  let real;
  try {
    real = await realpath(resolve(workDir, dir));
  } catch {
    throw new Error(`Root directory "${dir}" does not exist in the repository`);
  }
  const realWork = await realpath(workDir);
  if (real !== realWork && !real.startsWith(realWork + sep)) throw new Error(OUTSIDE);
  return real;
}
