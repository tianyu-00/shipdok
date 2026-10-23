// Which apps a deployment or control job is working on right now. The monitor leaves those alone: a swap stops the old
// container on purpose, and "recovering" it would fight the deployment.
export function createActivity() {
  const counts = new Map();
  return {
    isBusy: (appId) => (counts.get(appId) ?? 0) > 0,
    /** Marks the app busy until the returned function is called (once). */
    begin(appId) {
      counts.set(appId, (counts.get(appId) ?? 0) + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const left = counts.get(appId) - 1;
        if (left > 0) counts.set(appId, left); else counts.delete(appId);
      };
    },
    async run(appId, fn) {
      const end = this.begin(appId);
      try {
        return await fn();
      } finally {
        end();
      }
    },
  };
}
