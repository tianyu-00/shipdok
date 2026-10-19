// Imported FIRST by everything that reads the platform secrets from the environment: a secret that is not in the environment but has a
// <NAME>_FILE (as in the Docker volume the first-run service fills) is loaded into it. See packages/shared/src/secretfiles.js.
import { loadSecretFiles, applyPlatformDefaults } from "@shipdok/shared";

loadSecretFiles();
applyPlatformDefaults();
