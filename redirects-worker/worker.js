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

export default {
  async fetch(request) {
    let to = target(request.url);
    // Plain http:// visits are sent to the secure address.
    if (!to && request.url.startsWith('http://')) to = 'https://' + request.url.slice(7);
    if (!to || to === request.url) return fetch(request);
    return Response.redirect(to, 301);
  },
};
