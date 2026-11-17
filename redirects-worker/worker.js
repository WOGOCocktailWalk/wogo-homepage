// Redirects old Wix page addresses to the matching page on the new site.
// Runs only on the old paths listed in wrangler.toml; anything it does not
// recognise is passed through untouched.
const SITE = 'https://www.wogococktailwalk.com';
const EXACT = {
  "/amsterdam-cocktail-week-discovery-cocktail-walk": "/amsterdam/",
  "/amsterdam-cocktail-week-luxury-cocktail-walk": "/amsterdam/",
  "/amsterdam-cocktailwalk-route1": "/amsterdam/",
  "/amsterdam-cocktailwalk-route2-premium": "/amsterdam/",
  "/barcelona-cocktailwalk": "/",
  "/bars": "/for-bars/",
  "/book-online": "/",
  "/booking-calendar/delft-cocktail-walk": "/delft/book/",
  "/booking-calendar/groningen-cocktail-walk": "/groningen/book/",
  "/booking-calendar/rotterdam-cocktail-walk-route-2": "/rotterdam/route-2/book/",
  "/booking-calendar/rotterdam-premium-cocktail-walk": "/rotterdam/route-3-premium/book/",
  "/booking-calendar/utrecht-cocktail-walk": "/utrecht/book/",
  "/booking-calendar/wogo-cocktail-walk-route-1": "/amsterdam/book/",
  "/booking-calendar/wogo-rotterdam-cocktail-walk": "/rotterdam/route-1/book/",
  "/booking-calendar/wogo-rotterdam-cocktail-walk-route1": "/rotterdam/route-1/book/",
  "/booking-form": "/",
  "/cancel-reservation": "/contact/",
  "/copy-of-home": "/",
  "/experience-details": "/",
  "/experiences": "/",
  "/groningen-cocktail-walk": "/groningen/",
  "/groupbookings": "/groups/",
  "/plans-pricing": "/",
  "/post/5-best-cocktail-bars-to-visit-in-amsterdam-this-summer": "/amsterdam/",
  "/post/amsterdam-cocktail-week": "/amsterdam/",
  "/post/best-cocktail-bars-amsterdam": "/blog/best-cocktail-bars-amsterdam/",
  "/post/5-unique-birthday-celebration-ideas-in-the-netherlands-that-aren-t-just-another-dinner": "/blog/birthday-celebration-ideas-netherlands/",
  "/post/espresso-martini-recipe-amsterdam": "/blog/espresso-martini-recipe/",
  "/post/amsterdam-cocktail-week-bars": "/blog/amsterdam-cocktail-week-bars/",
  "/post/best-bars-in-amsterdam": "/amsterdam/",
  "/post/best-bars-in-groningen": "/groningen/",
  "/post/best-cocktail-bars-in-rotterdam": "/blog/best-cocktail-bars-in-rotterdam/",
  "/post/bobbys-cocktail-walk-groningen": "/groningen/",
  "/post/discover-an-ultimate-night-out-in-utrecht-one-cocktail-at-a-time": "/blog/utrecht-night-out-cocktails/",
  "/post/discover-rotterdam-s-new-premium-cocktail-walk-in-rotterdam-with-bobby-s-gin": "/blog/rotterdam-premium-gin-walk-launch/",
  "/post/discover-the-route-1-of-wogo-cocktail-walk-in-amsterdam": "/amsterdam/",
  "/post/new-bars-in-rotterdam-to-add-to-your-night-out": "/blog/new-bars-rotterdam-night-out/",
  "/post/summer-cocktail-recipes": "/blog/summer-cocktail-recipes/",
  "/post/top-5-cocktail-bars-in-rotterdam-on-the-wogo-cocktail-walk": "/blog/best-cocktail-bars-in-rotterdam/",
  "/post/top-7-bars-in-amsterdam": "/amsterdam/",
  "/post/top-7-bars-in-utrecht-to-visit-for-a-great-night-out": "/blog/top-7-bars-utrecht/",
  "/reservations": "/",
  "/rotterdam-cocktail-walk-route-2": "/rotterdam/route-2/",
  "/rotterdam-cocktail-walk-route1": "/rotterdam/route-1/",
  "/rotterdam-premium-cocktail-walk": "/rotterdam/route-3-premium/",
  "/schiedam-cocktail-walk": "/rotterdam/",
  "/search": "/",
  "/service-page/acw-discovery-cocktail-walk": "/amsterdam/",
  "/service-page/acw-luxury-cocktail-walk": "/amsterdam/",
  "/service-page/delft-cocktail-walk": "/delft/",
  "/service-page/groningen-cocktail-walk": "/groningen/",
  "/service-page/rotterdam-cocktail-walk-route-2": "/rotterdam/route-2/",
  "/service-page/rotterdam-premium-cocktail-walk": "/rotterdam/route-3-premium/",
  "/service-page/schiedam-cocktail-walk": "/rotterdam/",
  "/service-page/special-group-cocktail-walk": "/groups/",
  "/service-page/utrecht-cocktail-walk": "/utrecht/",
  "/service-page/wogo-cocktail-walk-route-1": "/amsterdam/",
  "/service-page/wogo-cocktail-walk-route-2-premium": "/amsterdam/",
  "/service-page/wogo-rotterdam-cocktail-walk-route1": "/rotterdam/route-1/",
  "/workwithus": "/for-bars/",
  "/nl": "/"
};
const PREFIX = [
  [
    "/booking-calendar/",
    "/"
  ],
  [
    "/blog/categories/",
    "/blog/"
  ],
  [
    "/product-page/",
    "/gift-cards/"
  ],
  [
    "/service-page/",
    "/"
  ],
  [
    "/blog/tags/",
    "/blog/"
  ],
  [
    "/category/",
    "/gift-cards/"
  ],
  [
    "/bars/",
    "/for-bars/"
  ],
  [
    "/post/",
    "/blog/"
  ],
  [
    "/nl/",
    "/"
  ]
];

export function target(url) {
  const u = new URL(url);
  const path = u.pathname.toLowerCase().replace(/\/+$/, '') || '/';
  let to = EXACT[path];
  if (to === undefined) {
    const withSlash = path + '/';
    const hit = PREFIX.find(([p]) => withSlash.startsWith(p));
    if (hit) to = hit[1];
  }
  const sub = u.hostname === 'nl.wogococktailwalk.com' || u.hostname === 'en.wogococktailwalk.com';
  if (to === undefined) {
    if (!sub) return null;
    to = u.pathname; // nl./en. were plain forwards to www on Wix
  }
  return SITE + to + u.search;
}

// Old Wix emails (map download, confirmations) wrap every button in a click
// counter on our own domain: /so/tr/<id>/c?w=<signature>.<base64url JSON>,
// where JSON.u is the real destination. Wix no longer answers on this domain,
// so we unpack the destination ourselves. Only known hosts are followed, so
// this can never be abused to forward people to a stranger's website.
const WIX_FILE_HOSTS = /(^|\.)(usrfiles\.com|filesusr\.com|wixstatic\.com)$/;
const OWN_HOSTS = /(^|\.)(wogococktailwalk\.com|wogoamsterdam\.com|wogorotterdam\.com|wogo\.city)$/;
export function wixEmailLink(url) {
  const u = new URL(url);
  if (!u.pathname.toLowerCase().startsWith('/so/')) return null;
  try {
    const w = u.searchParams.get('w') || '';
    const b64 = w.slice(w.indexOf('.') + 1).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const dest = new URL(JSON.parse(new TextDecoder().decode(bytes)).u);
    if (dest.protocol === 'mailto:' && /@wogo(amsterdam|cocktailwalk)\.com$/i.test(decodeURIComponent(dest.pathname))) return dest.href;
    if (dest.protocol !== 'https:' && dest.protocol !== 'http:') return SITE + '/';
    if (WIX_FILE_HOSTS.test(dest.hostname)) { dest.protocol = 'https:'; return dest.href; }
    if (OWN_HOSTS.test(dest.hostname) && !dest.pathname.toLowerCase().startsWith('/so/')) {
      if (/(^|\.)wogococktailwalk\.com$/.test(dest.hostname)) return target(dest.href) || (SITE + dest.pathname + dest.search);
      dest.protocol = 'https:'; return dest.href;
    }
  } catch (e) { /* unreadable link: fall back to the homepage */ }
  return SITE + '/';
}

export default {
  async fetch(request) {
    // Route maps (/maps/*.pdf) stay reachable for anyone with the link (the
    // confirmation email), but search engines are told not to list them: the
    // bars are meant to stay a surprise until someone has booked.
    try {
      const u0 = new URL(request.url);
      if (u0.protocol === 'https:' && u0.pathname.toLowerCase().startsWith('/maps/')) {
        const res = await fetch(request);
        const out = new Response(res.body, res);
        out.headers.set('X-Robots-Tag', 'noindex, nofollow');
        return out;
      }
    } catch (e) { /* fall through to the normal handling */ }
    const mail = wixEmailLink(request.url);
    if (mail) return Response.redirect(mail, 302);
    let to = target(request.url);
    // Plain http:// visits are sent to the secure address.
    if (!to && request.url.startsWith('http://')) to = 'https://' + request.url.slice(7);
    if (!to || to === request.url) return fetch(request);
    return Response.redirect(to, 301);
  },
};
