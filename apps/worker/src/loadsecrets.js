// Imported FIRST by everything in the worker that reads the platform secrets from the environment (db.js builds its pool when it is
// loaded): a secret that is not in the environment but has a <NAME>_FILE is loaded into it. See packages/shared/src/secretfiles.js.
import { loadSecretFiles, applyPlatformDefaults } from '@shipdok/shared';

loadSecretFiles();
applyPlatformDefaults();
