#!/usr/bin/env node
// First-run step of `docker compose up` (the `secrets` service): writes the platform secrets that the administrator did not give in
// the environment into the protected volume, and keeps any that are already there. Prints names, never values.
//
//   SECRETS_DIR   where the volume is mounted (default /run/shipdok-secrets)
import { ensureSecrets } from "@shipdok/shared";

const dir = process.env.SECRETS_DIR || "/run/shipdok-secrets";
try {
  const out = ensureSecrets({ dir });
  const say = (label, names) => names.length && console.log(`${label}: ${names.join(", ")}`);
  say("Generated", out.created);
  say("Kept (already in the volume)", out.kept);
  say("Taken from the environment (nothing written)", out.fromEnvironment);
  if (!out.created.length) console.log("Nothing to generate.");
} catch (err) {
  console.error(`Could not prepare the secrets in ${dir}: ${err.message}`);
  process.exit(1);
}
