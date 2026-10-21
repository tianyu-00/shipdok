// Pushes that were refused because no stored secret signed them, kept in MEMORY so the dashboard can say so (the history cannot: a delivery whose
// signature is wrong is not recorded, anyone on the internet can send one). One entry per sender, where the sender is the GitHub App number GitHub says
// sent it (the `X-GitHub-Hook-Installation-Target-ID` header, digits only) or null when it did not say. Nothing from the request is kept except that
// number, when it happened and how often. It is lost when the API restarts, which is fine: the next push repeats it.
const DAY_MS = 24 * 60 * 60 * 1000;

export function createRefusals({ max = 100, ttlMs = DAY_MS, now = () => Date.now() } = {}) {
  const entries = new Map(); // sender ('none' or the number) -> { appNumber, at, count }

  const live = () => {
    const cutoff = now() - ttlMs;
    for (const [key, e] of entries) if (e.at < cutoff) entries.delete(key);
    return [...entries.values()];
  };

  return {
    /** A delivery from `appNumber` (a string of digits, or null) was refused. */
    record(appNumber) {
      const key = appNumber ?? 'none';
      const before = entries.get(key);
      if (!before && entries.size >= max) entries.clear(); // bounded: many different senders cannot fill the memory
      entries.set(key, { appNumber, at: now(), count: (before?.count ?? 0) + 1 });
    },
    /** The problem with this app is over (a good delivery came, or its credentials were entered again, or it was removed). */
    clear(appNumber) {
      entries.delete(appNumber ?? 'none');
    },
    /** Newest first: [{ appNumber, at (ms), count }] */
    list() {
      return live().sort((a, b) => b.at - a.at);
    },
  };
}
