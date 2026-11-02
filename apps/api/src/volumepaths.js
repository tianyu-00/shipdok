// The container paths an app keeps (persistent storage): the rules live in @shipdok/shared, where the worker uses them too (reclaiming a backup adds paths).
export { MAX_VOLUMES, normalizeVolumePath, normalizeVolumePaths } from '@shipdok/shared';
