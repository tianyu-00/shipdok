// Which apps a deployment or control job is working on right now. The monitor leaves those alone: a swap stops the old
// container on purpose, and "recovering" it would fight the deployment.
export function createActivity() {
  const counts = new Map();
  return {
    isBusy: (appId) => (counts.get(appId) ?? 0) > 0,
    async run(appId, fn) {
      counts.set(appId, (counts.get(appId) ?? 0) + 1);
      try {
        return await fn();
      } finally {
        const left = counts.get(appId) - 1;
        if (left > 0) counts.set(appId, left); else counts.delete(appId);
      }
    },
  };
}
