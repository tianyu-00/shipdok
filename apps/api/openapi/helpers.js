// Small builders so that every operation is written the same way and the shared parts (errors, sign-in) are said once.
export const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
export const json = (schema) => ({ content: { 'application/json': { schema } } });
export const idParam = (name, description) => ({ name, in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } });
export const APP_ID = idParam('id', 'The app\'s id.');
export const DEPLOYMENT_ID = idParam('id', 'The deployment\'s id.');
export const query = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });

const errorResponse = (description) => ({ description, ...json(ref('Error')) });
export const ERRORS = {
  400: errorResponse('The request was not valid. `error` says what is wrong; `details` lists each problem when there are several.'),
  401: errorResponse('Not signed in, or the session ended (30 minutes without activity, or 12 hours in all).'),
  403: errorResponse('Refused: the Origin header is not one of Shipdok\'s own addresses, or the password given was wrong (`code: wrong_password`).'),
  404: errorResponse('Not found.'),
  409: errorResponse('The request conflicts with the current state. `code` names the reason where there is one.'),
  429: errorResponse('Too many tries. `Retry-After` and `retryAfterSeconds` say how long to wait.'),
  502: errorResponse('GitHub could not be reached or did not accept the request.'),
  503: errorResponse('The job queue (or the feature) is not available.'),
};
export const ok = (description, schema) => ({ description, ...(schema ? json(schema) : {}) });

/**
 * One operation.
 * @param {object} o
 * @param {string} o.tag
 * @param {string} o.summary           one line
 * @param {string} o.description       what it does, rules, side effects
 * @param {'session'|'none'|'signature'} [o.auth]  session = the administrator's login cookie (the default)
 * @param {object[]} [o.parameters]
 * @param {object} [o.body]            request body JSON schema
 * @param {boolean} [o.bodyRequired]
 * @param {Record<string, object>} o.responses   success responses by status
 * @param {number[]|Record<number,string>} [o.errors]  which error statuses can happen: a list (shared descriptions) or { status: 'description for this operation' }
 */
export function op({ tag, summary, description, auth = 'session', parameters = [], body, bodyRequired = true, responses, errors = [], rawBody }) {
  const out = { tags: [tag], summary, description, parameters, responses: { ...responses } };
  if (body) out.requestBody = { required: bodyRequired, ...json(body) };
  if (rawBody) out.requestBody = rawBody;
  out.security = auth === 'session' ? [{ session: [] }] : [];
  // `errors` is a list of statuses (the shared descriptions), or an object { status: 'a description specific to this operation' }.
  const custom = Array.isArray(errors) ? {} : errors;
  const statuses = new Set(Array.isArray(errors) ? errors : Object.keys(errors).map(Number));
  if (auth === 'session') statuses.add(401);
  for (const s of statuses) out.responses[s] = custom[s] ? errorResponse(custom[s]) : ERRORS[s];
  return out;
}

/** Operations by "METHOD /path": the same key the route inventory uses. */
export const route = (method, path, operation) => [`${method} ${path}`, operation];
