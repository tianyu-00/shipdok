#!/usr/bin/env node
// Sends a correctly SIGNED webhook to your API, the way GitHub would. For trying the webhook before the
// GitHub App exists, and for replaying a delivery.
//
//   npm run webhook -w apps/api -- ping
//   npm run webhook -w apps/api -- push --repo owner/name --branch main --sha <40 hex chars>
//   ... --delivery <id> to resend the SAME delivery (it should answer "duplicate")
//   ... --url http://localhost:4000 to target a different address
//
// Reads GITHUB_WEBHOOK_SECRET from the environment (infrastructure/.env). The secret is never printed.
import { createHmac, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    branch: { type: "string", default: "main" },
    sha: { type: "string" },
    delivery: { type: "string" },
    url: { type: "string", default: "http://localhost:4000" },
  },
});
const event = positionals[0];
const secret = process.env.GITHUB_WEBHOOK_SECRET;

if (!["ping", "push"].includes(event)) {
  console.error("Usage: send-webhook.js <ping|push> [--repo owner/name --branch main --sha <commit>]");
  process.exit(2);
}
if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET is not set (add it to infrastructure/.env)");
  process.exit(2);
}

let payload = { zen: "Keep it logically awesome.", hook_id: 1 };
if (event === "push") {
  if (!a.repo || !a.sha) {
    console.error("push needs --repo owner/name and --sha <commit>");
    process.exit(2);
  }
  payload = { ref: `refs/heads/${a.branch}`, after: a.sha, deleted: false, repository: { full_name: a.repo } };
}

const body = JSON.stringify(payload);
const delivery = a.delivery ?? randomUUID();
const res = await fetch(`${a.url}/api/webhooks/github`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": delivery,
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  },
  body,
});
console.log(`delivery ${delivery}\nHTTP ${res.status}\n${await res.text()}`);
