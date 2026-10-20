// The list of routes the API really has, read from the running Express app (not scanned from source text, which cannot follow
// routers that are built by functions and mounted under variable paths). Express 5 does not keep the path strings it was given, so this
// records them while the app is being built: it wraps Router's `route` (every get/post/put/delete) and `use` (mounting a router).
// Used by the OpenAPI generator and by the test that fails when a route has no documentation.
import express from 'express';

const toOpenApiPath = (path) => {
  const joined = ('/' + path).replace(/\/+/g, '/').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
};

/** @param {() => import('express').Express} build creates the app (nothing is listened on) @returns {{method: string, path: string}[]} sorted */
export function listRoutes(build) {
  const proto = express.Router.prototype;
  const routes = []; // { router, path, route }
  const mounts = []; // { parent, prefix, child }
  const { route: originalRoute, use: originalUse } = proto;
  proto.route = function route(path) {
    const r = originalRoute.call(this, path);
    routes.push({ router: this, path, route: r });
    return r;
  };
  proto.use = function use(...args) {
    const prefix = typeof args[0] === 'string' ? args[0] : '/';
    for (const fn of args.flat()) if (typeof fn === 'function' && Array.isArray(fn.stack)) mounts.push({ parent: this, prefix, child: fn });
    return originalUse.apply(this, args);
  };
  let app;
  try {
    app = build();
  } finally {
    proto.route = originalRoute;
    proto.use = originalUse;
  }

  const found = new Set();
  const walk = (router, prefix) => {
    for (const r of routes.filter((x) => x.router === router)) {
      for (const method of Object.keys(r.route.methods)) found.add(`${method.toUpperCase()} ${toOpenApiPath(`${prefix}/${r.path}`)}`);
    }
    for (const m of mounts.filter((x) => x.parent === router)) walk(m.child, `${prefix}/${m.prefix}`);
  };
  walk(app.router, '');
  return [...found].sort().map((key) => { const [method, path] = key.split(' '); return { method, path }; });
}
