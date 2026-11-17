// Local checks for the old-address forwarding helper. Nothing is deployed and
// nothing on the internet is touched. Run:   node redirects-worker/test.mjs
// It prints "all N checks passed" or lists what is wrong (and fails).
import worker, { target, wixEmailLink } from './worker.js';

const SITE = 'https://www.wogococktailwalk.com';
let failed = 0, n = 0;
function eq(what, got, want) {
  n++;
  if (got !== want) { failed++; console.error('FAIL ' + what + '\n     got:  ' + got + '\n     want: ' + want); }
}
// `want` is a path on the new site, or null for "left alone / served as it is".
function goes(from, want) {
  const url = from.startsWith('http') ? from : SITE + from;
  const got = target(url);
  const shown = got === null || got === url ? null : got.replace(SITE, '');
  eq(from, shown, want);
}

// --- English old addresses: unchanged behaviour ---
goes('/rotterdam-cocktail-walk-route1', '/rotterdam/route-1/');
goes('/rotterdam-cocktail-walk-route-2', '/rotterdam/route-2/');
goes('/rotterdam-premium-cocktail-walk', '/rotterdam/route-3-premium/');
goes('/groningen-cocktail-walk', '/groningen/');
goes('/amsterdam-cocktailwalk-route1', '/amsterdam/');
goes('/groupbookings', '/groups/');
goes('/workwithus', '/for-bars/');
goes('/bars', '/for-bars/');
goes('/booking-calendar/delft-cocktail-walk', '/delft/book/');
goes('/booking-calendar/something-else', '/');
goes('/service-page/utrecht-cocktail-walk', '/utrecht/');
goes('/post/best-cocktail-bars-in-rotterdam', '/blog/best-cocktail-bars-in-rotterdam/');
goes('/post/an-article-we-never-rebuilt', '/blog/');
goes('/product-page/gift-card', '/gift-cards/');
goes('/cancel-reservation', '/contact/');
goes('/Groupbookings/', '/groups/');
goes('/groupbookings?utm_source=old', '/groups/?utm_source=old');
// new English pages are never touched
goes('/', null);
goes('/faq/', null);
goes('/rotterdam/route-1/book/', null);
goes('/blog/top-7-bars-utrecht/', null);

// --- the Dutch pages of the new site are left alone (served as they are) ---
goes('/nl/', null);
goes('/nl/faq/', null);
goes('/nl/rotterdam/', null);
goes('/nl/rotterdam/route-1/', null);
goes('/nl/rotterdam/route-3-premium/book/', null);
goes('/nl/gift-cards/?utm_source=meta&fbclid=abc', null);
goes('/nl/terms/', null);
// the four occasion pages (added Nov 2026) exist in Dutch too
goes('/nl/date-night/', null);
goes('/nl/bachelorette/', null);
goes('/nl/birthday/', null);
goes('/nl/company-outing/', null);
goes('/nl/date-night', '/nl/date-night/');
goes('/date-night/', null);
// ...and get their trailing slash when it is missing
goes('/nl', '/nl/');
goes('/nl/faq', '/nl/faq/');
goes('/nl/about?utm_source=x', '/nl/about/?utm_source=x');
goes('/NL/How-It-Works', '/nl/how-it-works/');

// --- OLD Wix Dutch addresses now land on the matching DUTCH page ---
goes('/nl/rotterdam-cocktail-walk-route1', '/nl/rotterdam/route-1/');
goes('/nl/rotterdam-cocktail-walk-route-2', '/nl/rotterdam/route-2/');
goes('/nl/rotterdam-premium-cocktail-walk', '/nl/rotterdam/route-3-premium/');
goes('/nl/groningen-cocktail-walk', '/nl/groningen/');
goes('/nl/amsterdam-cocktailwalk-route1', '/nl/amsterdam/');
goes('/nl/groupbookings', '/nl/groups/');
goes('/nl/workwithus', '/nl/for-bars/');
goes('/nl/copy-of-home', '/nl/');
goes('/nl/privacy-policy', '/nl/privacy/');
goes('/nl/booking-calendar/delft-cocktail-walk', '/nl/delft/book/');
goes('/nl/booking-calendar/wogo-rotterdam-cocktail-walk-route1', '/nl/rotterdam/route-1/book/');
goes('/nl/booking-calendar/rotterdam-premium-cocktail-walk', '/nl/rotterdam/route-3-premium/book/');
goes('/nl/booking-calendar/utrecht-cocktail-walk?utm_campaign=old', '/nl/utrecht/book/?utm_campaign=old');
goes('/nl/booking-calendar/something-else', '/nl/');
goes('/nl/service-page/delft-cocktail-walk', '/nl/delft/');
goes('/nl/product-page/gift-card', '/nl/gift-cards/');
goes('/nl/post/de-beste-bars-in-groningen', '/blog/best-bars-in-groningen/');
goes('/nl/post/beste-bars-in-amsterdam', '/blog/best-bars-in-amsterdam/'); // the article itself is on the new blog since 17 Nov 2026
goes('/nl/something-nobody-knows', '/nl/');
// no Dutch blog yet: Dutch article addresses go to the (English) article
goes('/nl/post/de-7-beste-bars-in-utrecht-voor-een-fantastische-avond-uit', '/blog/top-7-bars-utrecht/');
goes('/nl/post/best-cocktail-bars-in-rotterdam', '/blog/best-cocktail-bars-in-rotterdam/');
goes('/nl/post/an-article-we-never-rebuilt', '/blog/');
goes('/nl/blog', '/blog/');
goes('/nl/blog/top-7-bars-utrecht', '/blog/top-7-bars-utrecht/');
goes('/nl/blog-feed.xml', '/blog/');
// anything else under /nl goes to the Dutch homepage
goes('/nl/london', '/nl/');

// --- nl. / en. sub-addresses: plain forward to www, as before ---
goes('https://nl.wogococktailwalk.com/about', '/about');
goes('https://en.wogococktailwalk.com/groupbookings', '/groups/');

// --- old Wix e-mail buttons still unpack (unchanged) ---
{
  const payload = Buffer.from(JSON.stringify({ u: 'https://www.wogococktailwalk.com/nl/groupbookings' })).toString('base64url');
  eq('old e-mail button with a Dutch address', wixEmailLink(SITE + '/so/tr/abc/c?w=sig.' + payload), SITE + '/nl/groups/');
  eq('not an e-mail button', wixEmailLink(SITE + '/faq/'), null);
}

// --- the worker itself: forwards with a 301, or hands the page through ---
{
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (req) => { seen.push(typeof req === 'string' ? req : req.url); return new Response('page', { status: 200 }); };
  try {
    let res = await worker.fetch(new Request(SITE + '/nl/groupbookings?utm_source=x'));
    eq('old Dutch address: status', res.status, 301);
    eq('old Dutch address: Location', res.headers.get('Location'), SITE + '/nl/groups/?utm_source=x');
    eq('old Dutch address: site not fetched', seen.length, 0);
    res = await worker.fetch(new Request(SITE + '/nl/faq/'));
    eq('Dutch page: handed through', res.status + ' ' + seen.join(','), '200 ' + SITE + '/nl/faq/');
    seen.length = 0;
    res = await worker.fetch(new Request(SITE + '/maps/rotterdam.pdf'));
    eq('route map: noindex header kept', res.headers.get('X-Robots-Tag'), 'noindex, nofollow');
    res = await worker.fetch(new Request('http://www.wogococktailwalk.com/nl/faq/'));
    eq('plain http Dutch page goes to https', res.status + ' ' + res.headers.get('Location'), '301 ' + SITE + '/nl/faq/');
  } finally { globalThis.fetch = realFetch; }
}

if (failed) { console.error('\n' + failed + ' of ' + n + ' checks FAILED'); process.exit(1); }
console.log('all ' + n + ' checks passed');
