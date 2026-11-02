import { op, route, ok, ref } from '../helpers.js';

export default Object.fromEntries([
  route('GET', '/api/audit', op({
    tag: 'Account', summary: 'The activity log',
    description: 'What the administrator did with the password and, as more is recorded, other things (apps, deployments, variables, storage), newest first, each with what changed. `details` lists the facts: a change has `from` and `to`. A secret is never recorded. Entries are kept for `keepDays` days. By default only what the administrator did is listed; `automatic=1` adds what Shipdok did by itself (a push that deployed, a scheduled backup).',
    parameters: [
      { name: 'limit', in: 'query', required: false, description: 'How many, 1 to 500 (default 20).', schema: { type: 'integer', minimum: 1, maximum: 500, default: 20 } },
      { name: 'category', in: 'query', required: false, description: 'Only this category.', schema: { type: 'string', enum: ['security', 'github', 'backups', 'apps', 'deployments', 'variables', 'storage'] } },
      { name: 'q', in: 'query', required: false, description: 'Only entries whose summary contains this text (any case), at most 100 characters.', schema: { type: 'string', maxLength: 100 } },
      { name: 'automatic', in: 'query', required: false, description: '`1` to include what Shipdok did by itself.', schema: { type: 'string', enum: ['1'] } },
    ],
    responses: { 200: ok('The entries, and for how many days they are kept.', { type: 'object', required: ['entries', 'keepDays'], properties: { entries: { type: 'array', items: ref('AuditEntry') }, keepDays: { type: 'integer' } } }) },
    errors: { 400: '`category` is not a known category, or `q` is too long.' },
  })),
]);
