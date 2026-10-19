// GitHub webhooks.
//
// POST /api/webhooks/github  is PUBLIC (reachable through a tunnel) and protected only by the HMAC signature,
// so the order matters: size limit -> signature -> shape checks -> only then the database.
// Nothing from the payload is trusted until re-validated: repository, branch and commit end up in git commands.
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requestDeployment } from '../deployments.js';
import { diskStatus, defaultDiskUsage } from '../disk.js';

const MAX_BODY = '5mb'; // GitHub allows up to 25 MB; real push payloads are far smaller
const SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/;
const DELIVERY_RE = /^[A-Za-z0-9-]{8,64}$/;
const EVENT_RE = /^[a-z_]{1,40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._\/-]{0,254}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // SHA-1, or SHA-256 for repositories that use it
const ZERO_SHA_RE = /^0+$/;

function validSignature(secret, raw, header) {
  if (typeof header !== 'string' || !SIGNATURE_RE.test(header)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected); // constant-time
}

// Turns a push payload into { repo, branch, sha } or explains why it will not deploy.
function parsePush(p) {
  const { ref, after, deleted, repository } = p;
  if (typeof ref !== 'string' || typeof after !== 'string' || typeof repository?.full_name !== 'string'
      || !REPO_RE.test(repository.full_name)) {
    return { problem: 'Malformed push payload' };
  }
  if (ref.startsWith('refs/tags/')) return { skip: 'Not a branch push (tag)' };
  if (!ref.startsWith('refs/heads/')) return { skip: 'Not a branch push' };
  const branch = ref.slice('refs/heads/'.length);
  if (!BRANCH_RE.test(branch)) return { problem: 'Malformed push payload' };
  if (deleted === true || ZERO_SHA_RE.test(after)) return { skip: 'The branch was deleted' };
  if (!SHA_RE.test(after)) return { problem: 'Malformed push payload' };
  return { repo: repository.full_name, branch, sha: after };
}

// Record a delivery, or take over one that may be retried. Returns false for a true duplicate.
async function claimDelivery(db, id, event) {
  const fresh = await db.query(
    `INSERT INTO webhook_deliveries (delivery_id, event, outcome) VALUES ($1, $2, 'processing')
     ON CONFLICT DO NOTHING RETURNING delivery_id`, [id, event]);
  if (fresh.rowCount) return true;
  // A redelivery after an error is allowed, and so is one whose first attempt died mid-flight (>5 minutes).
  const retry = await db.query(
    `UPDATE webhook_deliveries
        SET outcome = 'processing', reason = NULL, details = NULL, received_at = now(), processed_at = NULL
      WHERE delivery_id = $1
        AND (outcome = 'error' OR (outcome = 'processing' AND received_at < now() - interval '5 minutes'))
      RETURNING delivery_id`, [id]);
  return retry.rowCount === 1;
}

const finish = (db, id, outcome, reason, { repo = null, ref = null, sha = null, details = null } = {}) =>
  db.query(
    `UPDATE webhook_deliveries
        SET outcome = $2, reason = $3, repo = $4, ref = $5, commit_sha = $6, details = $7, processed_at = now()
      WHERE delivery_id = $1`,
    [id, outcome, reason, repo, ref && ref.slice(0, 200), sha, details ? JSON.stringify(details) : null]);

export function webhookReceiver({ db, queue, secret, rateLimitPerMinute = 120, logDir = '', diskUsage = defaultDiskUsage }) {
  const r = Router();
  r.use(rateLimit({
    windowMs: 60_000,
    limit: rateLimitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  }));

  r.post('/', express.raw({ type: () => true, limit: MAX_BODY }), async (req, res, next) => {
    let deliveryId = null;
    try {
      // 1. Disabled until a secret is configured: never accept unsigned traffic "because nothing is set up".
      const secretNow = typeof secret === 'function' ? await secret() : secret; // read live: connecting GitHub in the dashboard switches it on
      if (!secretNow) return res.status(503).json({ error: 'Webhooks are not configured' });

      // 2. Signature over the EXACT bytes received (hence the raw body parser, not JSON).
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!validSignature(secretNow, raw, req.get('x-hub-signature-256'))) {
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // 3. Only now look at anything else.
      const event = req.get('x-github-event');
      const delivery = req.get('x-github-delivery');
      if (!EVENT_RE.test(event ?? '') || !DELIVERY_RE.test(delivery ?? '')) {
        return res.status(400).json({ error: 'Missing or invalid X-GitHub-Event or X-GitHub-Delivery header' });
      }
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { payload = null; }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: 'The payload must be a JSON object (set the webhook content type to application/json)' });
      }
      if (event === 'push' && !queue) return res.status(503).json({ error: 'Deployment queue unavailable' });

      // 4. Deduplicate by GitHub's delivery id.
      if (!(await claimDelivery(db, delivery, event))) return res.status(200).json({ status: 'duplicate' });
      deliveryId = delivery;

      if (event === 'ping') {
        await finish(db, delivery, 'ignored', 'ping');
        return res.status(200).json({ status: 'ignored', reason: 'ping' });
      }
      if (event !== 'push') {
        await finish(db, delivery, 'ignored', `Unsupported event: ${event}`);
        return res.status(200).json({ status: 'ignored', reason: `Unsupported event: ${event}` });
      }

      // 5. A push.
      const parsed = parsePush(payload);
      if (parsed.problem || parsed.skip) {
        const reason = parsed.problem ?? parsed.skip;
        await finish(db, delivery, 'ignored', reason, { ref: typeof payload.ref === 'string' ? payload.ref : null });
        return res.status(200).json({ status: 'ignored', reason });
      }
      const { repo, branch, sha } = parsed;
      const meta = { repo, ref: branch, sha };

      const { rows: apps } = await db.query(
        'SELECT * FROM apps WHERE lower(repo) = lower($1) AND branch = $2 ORDER BY created_at', [repo, branch]);
      if (!apps.length) {
        await finish(db, delivery, 'ignored', 'No app tracks this repository and branch', meta);
        return res.status(200).json({ status: 'ignored', reason: 'No app tracks this repository and branch' });
      }

      const details = [];
      const deployments = [];
      let failed = false;
      let diskSkipped = 0;
      // Nobody is here to ask "build anyway?", so a push that would be built on an almost full disk is NOT built. The
      // delivery history says why; a redelivery after freeing space, or a manual deployment, builds it.
      const disk = await diskStatus(diskUsage, logDir);
      for (const app of apps) {
        if (app.deleting_at) {
          details.push({ app: app.slug, result: 'skipped', reason: 'The app is being deleted' });
          continue;
        }
        if (app.desired_state === 'stopped') {
          details.push({ app: app.slug, result: 'skipped', reason: 'The app is stopped' });
          continue;
        }
        if (disk?.level === 'critical') {
          diskSkipped += 1;
          details.push({ app: app.slug, result: 'skipped', reason: `The disk is almost full (${disk.freePercent}% free)` });
          continue;
        }
        const out = await requestDeployment({ db, queue }, app, { trigger: 'webhook', commit: sha, deliveryId: delivery });
        if (!out.ok) {
          failed = true;
          details.push({ app: app.slug, result: 'error', reason: 'Could not enqueue the deployment job' });
        } else if (out.duplicate) {
          details.push({ app: app.slug, result: 'already-deployed', deploymentId: out.deploymentId });
          if (out.deploymentId) deployments.push(out.deploymentId);
        } else {
          details.push({ app: app.slug, result: 'deployed', deploymentId: out.deploymentId });
          deployments.push(out.deploymentId);
        }
      }

      if (failed) {
        await finish(db, delivery, 'error', 'Could not enqueue a deployment for at least one app', { ...meta, details });
        return res.status(503).json({ status: 'error', deployments });
      }
      if (!deployments.length) {
        const reason = diskSkipped > 0
          ? 'The disk is almost full, so nothing was built. Free some space and redeliver, or deploy manually'
          : apps.every((a) => a.deleting_at) ? 'Every app tracking this branch is being deleted'
            : apps.some((a) => a.deleting_at) ? 'Every app tracking this branch is stopped or being deleted'
            : 'Every app tracking this branch is stopped';
        await finish(db, delivery, 'ignored', reason, { ...meta, details });
        return res.status(200).json({ status: 'ignored', reason });
      }
      await finish(db, delivery, 'deployed', null, { ...meta, details });
      return res.status(202).json({ status: 'deployed', deployments });
    } catch (err) {
      // Leave a retryable record so a redelivery from GitHub is processed, then let the error handler answer.
      if (deliveryId) await finish(db, deliveryId, 'error', 'Internal error').catch(() => {});
      next(err);
    }
  });

  return r;
}

// Authenticated history of deliveries: "why didn't my push deploy?"
export function deliveriesRouter({ db }) {
  const r = Router();
  r.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT delivery_id, event, repo, ref, commit_sha, outcome, reason, details, received_at, processed_at
           FROM webhook_deliveries ORDER BY received_at DESC LIMIT 50`);
      res.json(rows);
    } catch (err) { next(err); }
  });
  return r;
}
