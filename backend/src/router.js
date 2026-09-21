// src/router.js — ~30-line manual method+path router, zero-dep.
//
// Routes are registered as { method, pattern, handler }. `pattern` supports
// ':param' segments (e.g. '/admin/api/routes/:id'). Matching populates
// `params` on the returned match, passed as the second arg to the handler.

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const segs = pattern.split('/').filter(Boolean);
    routes.push({ method, segs, handler });
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
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match,
  };
}
