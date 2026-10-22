// What the backup tests need that the other tests do not: the platform key the app was started with, and the decryption to read what it stored.
import { decryptSecret, parseMasterKey } from '@shipdok/shared';

export { decryptSecret };
export const loadSecretsKeyForTests = () => parseMasterKey(process.env.APP_SECRETS_KEY);
