// src/router.js — ~30-line manual method+path router, zero-dep.
//
// Routes are registered as { method, pattern, handler }. `pattern` supports
// ':param' segments (e.g. '/admin/api/routes/:id'). Matching populates
// `params` on the returned match, passed as the second arg to the handler.

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const segs = pattern.split('/').filter(Boolean);
    routes.push({ method, pattern, segs, handler });
  }

  function match(method, pathname) {
    const pathSegs = pathname.split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segs.length !== pathSegs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segs.length; i++) {
        const rs = route.segs[i];
        const ps = pathSegs[i];
        if (rs.startsWith(':')) {
          params[rs.slice(1)] = decodeURIComponent(ps);
        } else if (rs !== ps) {
          ok = false;
          break;
        }
      }
      // `pattern`/`method` round-trip the ORIGINAL registration string (e.g.
      // '/admin/api/bookings/:id') — used by src/admin_api.js's ROUTE_ROLES
      // table to look up the minimum role for the route that actually
      // matched, keyed exactly as `${method} ${pattern}`.
      if (ok) return { handler: route.handler, params, pattern: route.pattern, method: route.method };
    }
    return null;
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match,
    // Test-only introspection (test/admin_users.test.js asserts every
    // registered /admin/api/* route has a ROUTE_ROLES entry) — not used by
    // any production code path.
    routes: () => routes.map((r) => ({ method: r.method, pattern: r.pattern })),
  };
}
