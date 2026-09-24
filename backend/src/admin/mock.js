/* ==========================================================================
   WOGO Admin — PREVIEW MOCK LAYER  (loaded ONLY inside preview/admin.html)
   Intercepts window.fetch for /admin/* so the whole dashboard is explorable
   from a file:// with realistic data — 4 cities, a busy week, every state.
   Never shipped to the Worker.
   ========================================================================== */
(function () {
  "use strict";

  /* ---- date helpers (relative to real today so the preview stays "current") */
  function dstr(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
  const day = (off) => dstr(new Date(TODAY.getTime() + off * 864e5));
  // ISO weekday (Mon=1..Sun=7) of a 'YYYY-MM-DD' string — mirrors
  // src/logic.js:isoWeekday, used by the weekday-capacity/weekday-bars demo
  // guards below.
  function isoWeekdayOf(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    const w = d.getUTCDay();
    return w === 0 ? 7 : w;
  }

  /* ---- routes: 6 real WOGO routes across 4 cities ---- */
  const routes = [
    { id: "amsterdam", name: "WOGO Cocktail Walk Amsterdam", city: "Amsterdam", price_cents: 2995, capacity: 10, max_party: 6, open_days: "[4,5,6]", slots: '["17:30","18:00","18:30","19:00","19:30","20:00"]', map_url: null, active: 1, created_at: "2024-11-01" },
    // slots is OBJECT-shaped here on purpose — demonstrates "different start
    // times per weekday" (SPEC): weekdays get the usual evening-only
    // schedule, Sat/Sun add two earlier afternoon departures. open_days
    // ([1..7]) matches every key below that has >=1 time, same invariant
    // the server enforces (admin_api.js:parseSlotsField).
    // weekday_capacity (migrations/0014) demonstrates the per-weekday
    // capacity feature on a route that's ALSO in "Different times per day"
    // mode (its slots are object-shaped, above) — that's the only mode the
    // admin editor's seats-per-weekday control lives in, so this route
    // shows a value the owner can actually see and edit, not a hidden one.
    // Saturdays (weekday 6) cap at 6 seats/departure; every other open day
    // keeps the normal 10.
    { id: "utrecht", name: "WOGO Cocktail Walk Utrecht", city: "Utrecht", price_cents: 2995, capacity: 10, max_party: 6, open_days: "[1,2,3,4,5,6,7]", slots: '{"1":["17:30","18:30","19:30"],"2":["17:30","18:30","19:30"],"3":["17:30","18:30","19:30"],"4":["17:30","18:30","19:30"],"5":["17:30","18:30","19:30"],"6":["13:00","14:00","17:30","18:30","19:30"],"7":["13:00","14:00","17:30","18:30","19:30"]}', weekday_capacity: '{"6":6}', map_url: "https://www.wogococktailwalk.com/maps/utrecht-en.pdf", map_url_nl: "https://www.wogococktailwalk.com/maps/utrecht-nl.pdf", active: 1, created_at: "2024-11-01" },
    { id: "groningen", name: "WOGO Cocktail Walk Groningen", city: "Groningen", price_cents: 2995, capacity: 10, max_party: 6, open_days: "[3,4,5,6]", slots: '["17:00","17:30","18:00","18:30","19:00","19:30"]', map_url: null, active: 1, created_at: "2024-11-01" },
    { id: "rotterdam-witte-de-with", name: "Rotterdam Route 1 · Witte de With", city: "Rotterdam", price_cents: 2995, capacity: 10, max_party: 6, open_days: "[4,5,6]", slots: '["17:00","18:00"]', map_url: null, active: 1, created_at: "2024-11-01" },
    // slot_capacity demonstrates the per-timeslot capacity feature (migrations/0003):
    // this route defaults to 10 seats/departure, but its 20:00 slot only ever has 6
    // (the last bar on this route gets busy at that hour) — every other slot is
    // untouched. See also the 'slot_capacity_override' date override below, which
    // caps 20:00 further still for one specific Saturday.
    { id: "rotterdam-hidden-gems", name: "Rotterdam Route 2 · Hidden Gems (best seller)", city: "Rotterdam", price_cents: 2995, capacity: 10, max_party: 6, open_days: "[4,5,6]", slots: '["18:00","18:30","19:00","19:30","20:00"]', slot_capacity: '{"20:00":6}', map_url: "https://maps.wogo/rtm-hidden", active: 1, created_at: "2024-11-01" },
    { id: "rotterdam-premium-gin", name: "Rotterdam Premium · High-end Bars", city: "Rotterdam", price_cents: 3495, capacity: 8, max_party: 6, open_days: "[2,3,4,5,6]", slots: '["18:00","19:00","20:00"]', map_url: null, active: 0, created_at: "2025-02-01" }
  ];

  const bars = {
    amsterdam: [
      { id: 1, route_id: "amsterdam", ord: 1, bar_name: "Van de Werf (NDSM wharf)", bar_email: "hi@vandewerf.nl", minutes_offset: 0 },
      { id: 2, route_id: "amsterdam", ord: 2, bar_name: "Pllek", bar_email: "reserve@pllek.nl", minutes_offset: 75 },
      { id: 3, route_id: "amsterdam", ord: 3, bar_name: "Bar 3 (TBD — set real name/email)", bar_email: "bookings@wogoamsterdam.com", minutes_offset: 150 }
    ],
    // weekday demonstrates the per-weekday bar-set feature (migrations/0015):
    // the DEFAULT set (weekday: null) runs every open day except Saturday,
    // which has its own recurring set below — a standing rule, distinct from
    // the one-off per-date "Alt bars" override demoed on rotterdam-hidden-gems.
    utrecht: [
      { id: 4, route_id: "utrecht", ord: 1, bar_name: "Café Olivier", bar_email: "info@caféolivier.nl", minutes_offset: 0, weekday: null },
      { id: 5, route_id: "utrecht", ord: 2, bar_name: "Bar 2 (TBD)", bar_email: "bookings@wogoamsterdam.com", minutes_offset: 75, weekday: null },
      { id: 6, route_id: "utrecht", ord: 1, bar_name: "Kalff (Saturday route)", bar_email: "hi@kalff.nl", minutes_offset: 0, weekday: 6 },
      { id: 7, route_id: "utrecht", ord: 2, bar_name: "Bar 2 (TBD)", bar_email: "bookings@wogoamsterdam.com", minutes_offset: 75, weekday: 6 }
    ]
  };

  const overrides = {
    amsterdam: [
      { id: 11, route_id: "amsterdam", date: day(4), action: "closed", payload: null },
      { id: 12, route_id: "amsterdam", date: day(5), action: "capacity_override", payload: JSON.stringify({ capacity: 6 }) }
    ],
    "rotterdam-hidden-gems": [
      { id: 13, route_id: "rotterdam-hidden-gems", date: day(2), action: "alternate_bars", payload: JSON.stringify([{ bar_name: "Aloha", bar_email: "aloha@rtm.nl", minutes_offset: 0 }, { bar_name: "Ballroom", bar_email: "ballroom@rtm.nl", minutes_offset: 80 }]) },
      // slot_capacity_override demo: this one Saturday, 20:00 drops further
      // still to 4 seats (the route-level default above already caps it at
      // 6) — every other slot that date keeps its normal capacity.
      { id: 14, route_id: "rotterdam-hidden-gems", date: day(3), action: "slot_capacity_override", payload: JSON.stringify({ "20:00": 4 }) }
    ]
  };

  /* ---- bookings: a busy week spread across routes/slots ---- */
  const FIRST = ["Anna", "Sofie", "Lars", "Emma", "Daan", "Julia", "Tim", "Noa", "Lucas", "Fleur", "Sem", "Lieke", "Bram", "Sara", "Finn", "Nina", "Ruben", "Isa", "Thijs", "Mila", "Jesse", "Roos", "Kai", "Evi"];
  const LAST = ["de Vries", "Jansen", "Bakker", "Visser", "Smit", "Meijer", "Mulder", "Bos", "Vos", "Peters", "Hendriks", "Dekker", "Brouwer", "Kok", "Willems"];
  const STAT = ["confirmed", "confirmed", "confirmed", "confirmed", "confirmed", "hold", "cancelled"];

  let seq = 1000;
  const bookings = [];
  function addBooking(routeId, date, slot, party, status, extra) {
    const r = routes.find((x) => x.id === routeId);
    extra = extra || {};
    const fn = FIRST[seq % FIRST.length], ln = LAST[(seq * 7) % LAST.length];
    const created = dstr(new Date(new Date(date).getTime() - ((seq % 9) + 1) * 864e5));
    const manual = extra.source === "manual";
    bookings.push({
      id: "b_" + (seq++).toString(36) + Math.random().toString(36).slice(2, 6),
      route_id: routeId, route_name: r.name, city: r.city,
      date, slot, party,
      name: extra.name || (fn + " " + ln),
      email: extra.email || ((fn + "." + ln.replace(/\s/g, "")).toLowerCase() + "@example.com"),
      phone: extra.phone || ("+316" + (10000000 + (seq * 131) % 89999999)),
      locale: seq % 3 === 0 ? "nl" : "en",
      marketing_opt_in: seq % 2,
      status: status || STAT[seq % STAT.length],
      source: extra.source || "web",
      payment_status: extra.payment_status || null,
      discount_code: extra.discount_code || null,
      discount_cents: extra.discount_cents || 0,
      stripe_session: (manual || status === "hold") ? null : "cs_test_" + (seq).toString(36) + "x9",
      created_at: created + "T14:0" + (seq % 6) + ":00Z",
      hold_expires: status === "hold" ? new Date(Date.now() + 8 * 60000).toISOString() : null
    });
  }

  // seed a realistic spread: today-2 .. today+6
  const plan = [
    ["amsterdam", 0, ["17:30", 4], ["18:00", 6], ["18:00", 3], ["18:30", 2], ["19:00", 5], ["19:30", 3]],
    ["amsterdam", 1, ["18:00", 4], ["18:30", 4], ["19:00", 2]],
    ["amsterdam", 7, ["18:00", 6], ["18:00", 4]],               // slot fully sold out (10/10)
    ["utrecht", 0, ["17:30", 2], ["18:30", 3], ["19:30", 4]],
    ["utrecht", 1, ["17:30", 5], ["18:30", 2]],
    ["utrecht", -1, ["18:30", 4]],
    ["groningen", 0, ["17:00", 3], ["18:00", 5], ["18:30", 2], ["19:30", 4]],
    ["groningen", 1, ["17:30", 6], ["18:00", 3]],
    ["rotterdam-witte-de-with", 0, ["17:00", 4], ["18:00", 2]],
    ["rotterdam-hidden-gems", 0, ["18:00", 6], ["18:30", 4], ["19:00", 5], ["19:30", 2], ["20:00", 3]],
    ["rotterdam-hidden-gems", 2, ["18:00", 4], ["18:30", 6], ["19:00", 3]],
    ["rotterdam-hidden-gems", -2, ["18:30", 5]],
    ["rotterdam-premium-gin", 1, ["19:00", 2]]
  ];
  plan.forEach((row) => {
    const routeId = row[0], off = row[1];
    for (let i = 2; i < row.length; i++) {
      const forceStatus = (routeId === "amsterdam" && off === 7) ? "confirmed" : undefined;
      addBooking(routeId, day(off), row[i][0], row[i][1], forceStatus);
    }
  });
  // one confirmed_conflict to show the plum badge
  addBooking("rotterdam-hidden-gems", day(0), "18:00", 2, "confirmed_conflict");
  // Guests on the SAME Saturday (day+3) whose 20:00 departure is capped to 4
  // seats by the slot_capacity_override above — so Participants-per-hour shows
  // "2 / 4 seats · Override" for 20:00 while 19:00 keeps the normal 10. Pick
  // rotterdam-hidden-gems + this date to see the per-date editor in action.
  addBooking("rotterdam-hidden-gems", day(3), "20:00", 2, "confirmed");
  addBooking("rotterdam-hidden-gems", day(3), "19:00", 3, "confirmed");

  /* ---- Dashboard v2 seeds ---- */
  // Capacity-at-a-glance demo, guaranteed inside the current week (they sit
  // on TODAY, so the week grid always shows them): Groningen's 19:00 fills
  // to exactly 10/10 (FULL) and 17:30 to 8/10 (AMBER, ≥70%).
  addBooking("groningen", day(0), "19:00", 6, "confirmed");
  addBooking("groningen", day(0), "19:00", 4, "confirmed");
  addBooking("groningen", day(0), "17:30", 4, "confirmed");
  addBooking("groningen", day(0), "17:30", 4, "confirmed");
  // Repeat customer whose 2nd booking used a Stripe promo code:
  // WELCOME10, €3,00 saved — shows in the Customers tab's Discount column.
  const maartje = { name: "Maartje Kuiper", email: "maartje.kuiper@example.com", phone: "+31612345678" };
  addBooking("utrecht", day(-21), "18:30", 2, "confirmed", maartje);
  addBooking("rotterdam-hidden-gems", day(2), "19:00", 2, "confirmed",
    Object.assign({ discount_code: "WELCOME10", discount_cents: 300 }, maartje));
  // A manual (phone) booking the owner typed in herself — source badge +
  // payment status visible in Bookings, Customers and the drawers.
  addBooking("amsterdam", day(1), "18:30", 4, "confirmed",
    { name: "Hugo Verbeek", email: "hugo.verbeek@example.com", phone: "+31687654321", source: "manual", payment_status: "paid_invoice" });

  /* ---- gift cards (migrations/0018/0019) — a handful of sample cards
     across every status, so the admin preview shows the full picture. ---- */
  const giftCards = [
    { id: "gc_1", code: "WOGO-7F3K-9QRT", initial_cents: 6000, balance_cents: 6000, currency: "EUR", status: "active", buyer_name: "Sophie Bakker", buyer_email: "sophie.bakker@example.com", recipient_name: "Anna de Vries", recipient_email: "anna@example.com", message: "Happy birthday! Enjoy a night out.", stripe_session: "cs_mock_gift_1", locale: "en", created_at: day(-6) },
    { id: "gc_2", code: "WOGO-4M2X-P8WD", initial_cents: 10000, balance_cents: 4010, currency: "EUR", status: "active", buyer_name: "Tom Jansen", buyer_email: "tom.jansen@example.com", recipient_name: "Hugo Verbeek", recipient_email: "hugo.verbeek@example.com", message: "", stripe_session: "cs_mock_gift_2", locale: "nl", created_at: day(-19) },
    { id: "gc_3", code: "WOGO-QW5T-2NBH", initial_cents: 3000, balance_cents: 0, currency: "EUR", status: "depleted", buyer_name: "Lotte Smit", buyer_email: "lotte.smit@example.com", recipient_name: "Maartje Willems", recipient_email: "maartje@example.com", message: "Cheers to us!", stripe_session: "cs_mock_gift_3", locale: "nl", created_at: day(-33) },
    { id: "gc_4", code: "WOGO-8YV3-HK6C", initial_cents: 3000, balance_cents: 3000, currency: "EUR", status: "void", buyer_name: "Bram de Groot", buyer_email: "bram@example.com", recipient_name: "Els Peeters", recipient_email: "els@example.com", message: "", stripe_session: "cs_mock_gift_4", locale: "en", created_at: day(-40) }
  ];

  /* ---- customers: derived from bookings (mirrors logic.js:aggregateCustomers) ---- */
  function bookingSpendCents(b) {
    if (!(b.status === "confirmed" || b.status === "confirmed_conflict")) return 0;
    if (b.payment_status === "free" || b.payment_status === "comp") return 0;
    const r = routes.find((x) => x.id === b.route_id);
    return Math.max(0, (r ? r.price_cents : 0) * b.party - (b.discount_cents || 0));
  }
  function aggregateCustomers(rows, qStr) {
    const byEmail = {};
    rows.forEach((row) => {
      const key = String(row.email || "").trim().toLowerCase();
      if (!key) return;
      let c = byEmail[key];
      if (!c) {
        c = byEmail[key] = {
          email: key, name: row.name || "", phone: row.phone || "",
          bookings_count: 0, guests: 0, total_spent_cents: 0, discount_total_cents: 0,
          last_booking: null, first_booking: null, _last: ""
        };
      }
      c.bookings_count += 1;
      if (row.status === "confirmed" || row.status === "confirmed_conflict") c.guests += row.party || 0;
      c.total_spent_cents += bookingSpendCents(row);
      c.discount_total_cents += row.discount_cents || 0;
      if (row.date && (!c.last_booking || row.date > c.last_booking)) c.last_booking = row.date;
      if (row.date && (!c.first_booking || row.date < c.first_booking)) c.first_booking = row.date;
      const created = String(row.created_at || "");
      if (created >= c._last) { c._last = created; if (row.name) c.name = row.name; if (row.phone) c.phone = row.phone; }
    });
    let list = Object.keys(byEmail).map((k) => { const c = byEmail[k]; delete c._last; return c; });
    const needle = (qStr || "").trim().toLowerCase();
    if (needle) {
      list = list.filter((c) =>
        c.name.toLowerCase().indexOf(needle) >= 0 ||
        c.email.indexOf(needle) >= 0 ||
        (c.phone || "").toLowerCase().indexOf(needle) >= 0);
    }
    list.sort((a, b) => String(b.last_booking || "").localeCompare(String(a.last_booking || "")));
    return list;
  }

  /* ---------------- fetch interceptor ---------------- */
  const realFetch = window.fetch.bind(window);
  let loggedIn = false;

  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: status || 200, headers: { "Content-Type": "application/json" }
    }));
  }
  function match(path, re) { const m = path.match(re); return m; }

  window.fetch = function (url, opts) {
    opts = opts || {};
    const u = new URL(url, location.href);
    const path = u.pathname.replace(/\/$/, "");
    const q = u.searchParams;
    const method = (opts.method || "GET").toUpperCase();
    const bodyObj = opts.body ? JSON.parse(opts.body) : null;

    if (path.indexOf("/admin") !== 0) return realFetch(url, opts);

    // auth
    if (path === "/admin/login" && method === "POST") {
      if (bodyObj && bodyObj.token && bodyObj.token.length >= 1) { loggedIn = true; return json({ ok: true }); }
      return json({ error: "invalid_token" }, 401);
    }
    if (path === "/admin/logout") { loggedIn = false; return json({ ok: true }); }
    if (!loggedIn) return json({ error: "unauthenticated" }, 401);

    // routes
    if (path === "/admin/api/routes" && method === "GET") return json({ routes: routes.slice() });
    if (path === "/admin/api/routes" && method === "POST") { routes.push(Object.assign({ created_at: dstr(TODAY) }, bodyObj)); return json({ ok: true, route: bodyObj }); }

    let m;
    if ((m = match(path, /^\/admin\/api\/routes\/([^\/]+)\/bars$/))) {
      const rid = m[1];
      if (method === "GET") return json({ bars: (bars[rid] || []).slice() });
      if (method === "PUT") {
        // Per-weekday bar sets (migrations/0015): omitted/null weekday
        // replaces only the DEFAULT set; an ISO weekday 1-7 replaces ONLY
        // that weekday's own set — mirrors db.js:replaceBars exactly.
        const weekday = (bodyObj.weekday === undefined || bodyObj.weekday === null) ? null : bodyObj.weekday;
        const kept = (bars[rid] || []).filter((b) => (b.weekday == null ? null : b.weekday) !== weekday);
        const replaced = (bodyObj.bars || []).map((b, i) => Object.assign({ id: 900 + i, route_id: rid, weekday }, b));
        bars[rid] = kept.concat(replaced);
        return json({ ok: true, bars: bars[rid].slice() });
      }
    }
    if ((m = match(path, /^\/admin\/api\/routes\/([^\/]+)$/)) && method === "PUT") {
      const r = routes.find((x) => x.id === m[1]); if (r) Object.assign(r, bodyObj); return json({ ok: true });
    }
    if ((m = match(path, /^\/admin\/api\/bookings\/([^\/]+)\/resend$/))) return json({ ok: true });

    // Move (reschedule) a booking — mirrors the Worker: only confirmed bookings
    // move, and the in-memory row is updated so the calendar repaints correctly.
    if ((m = match(path, /^\/admin\/api\/bookings\/([^\/]+)\/reschedule$/)) && method === "POST") {
      const b = bookings.find((x) => x.id === m[1]);
      if (!b) return json({ error: "not_found", message: "booking not found" }, 404);
      if (!(b.status === "confirmed" || b.status === "confirmed_conflict")) return json({ error: "not_movable", message: "only confirmed bookings can be moved" }, 409);
      if (bodyObj.date) b.date = bodyObj.date;
      if (bodyObj.slot) b.slot = bodyObj.slot;
      return json({ booking: b });
    }
    // Cancel a booking — frees the seat (status → cancelled). Refund is manual.
    if ((m = match(path, /^\/admin\/api\/bookings\/([^\/]+)\/cancel$/)) && method === "POST") {
      const b = bookings.find((x) => x.id === m[1]);
      if (!b) return json({ error: "not_found", message: "booking not found" }, 404);
      if (!(b.status === "confirmed" || b.status === "confirmed_conflict")) return json({ error: "not_cancellable", message: "only confirmed bookings can be cancelled" }, 409);
      b.status = "cancelled"; b.hold_expires = null;
      return json({ booking: b });
    }

    // date overrides
    if (path === "/admin/api/date-overrides" && method === "GET") { const rid = q.get("route"); return json({ overrides: (overrides[rid] || []).slice() }); }
    if (path === "/admin/api/date-overrides" && method === "POST") {
      // Mirror the Worker's INSERT OR REPLACE: one row per (route,date,action).
      // Re-posting a slot_capacity_override for the same date REPLACES the whole
      // map rather than stacking duplicates — so the preview behaves like prod.
      const rid = bodyObj.route_id;
      const arr = (overrides[rid] = overrides[rid] || []);
      const existing = arr.find((o) => o.date === bodyObj.date && o.action === bodyObj.action);
      if (existing) { existing.payload = bodyObj.payload != null ? bodyObj.payload : null; return json({ ok: true, override: existing }); }
      const row = Object.assign({ id: Math.floor(Math.random() * 1e6) }, bodyObj);
      arr.push(row); return json({ ok: true, override: row });
    }
    if ((m = match(path, /^\/admin\/api\/date-overrides\/(\d+)$/)) && method === "DELETE") {
      const id = +m[1]; for (const k in overrides) overrides[k] = overrides[k].filter((o) => o.id !== id); return json({ ok: true });
    }

    // customers (CRM) — derived from bookings, same as the Worker
    if (path === "/admin/api/customers" && method === "GET") {
      return json({ customers: aggregateCustomers(bookings, q.get("q")) });
    }
    if ((m = match(path, /^\/admin\/api\/customers\/(.+)$/))) {
      const email = decodeURIComponent(m[1]).trim().toLowerCase();
      const own = bookings.filter((b) => String(b.email || "").trim().toLowerCase() === email);
      if (own.length === 0) return json({ error: "not_found", message: "no bookings found for that email" }, 404);
      if (method === "GET") {
        const customer = aggregateCustomers(own)[0];
        const list = own.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return json({ customer, bookings: list });
      }
      if (method === "PUT") {
        // propagate the edit onto EVERY booking row for this email — exactly
        // what db.js:updateCustomer's single UPDATE does in the Worker.
        own.forEach((b) => {
          if (bodyObj.name) b.name = bodyObj.name;
          if ("phone" in bodyObj) b.phone = bodyObj.phone || null;
          if (bodyObj.email) b.email = String(bodyObj.email).toLowerCase();
        });
        return json({ ok: true, updated: own.length });
      }
    }

    // manual (phone) booking — same atomic capacity guard as the Worker:
    // effective capacity is date+slot override > date-wide > route per-slot
    // > route default; competes with confirmed/conflict/active-hold seats.
    if (path === "/admin/api/bookings/manual" && method === "POST") {
      const p = bodyObj || {};
      const r = routes.find((x) => x.id === p.route_id);
      if (!r) return json({ error: "route_not_found", message: "route_not_found" }, 404);
      if (!p.date || !p.slot || !(p.party >= 1) || !p.name || !p.email) {
        return json({ error: "bad_request", message: "route, date, slot, party, name and email are required" }, 400);
      }
      let routeSlots = {};
      try { routeSlots = JSON.parse(r.slot_capacity || "{}") || {}; } catch (e) { routeSlots = {}; }
      // weekday_capacity (migrations/0014) — same precedence level as the
      // Worker: between route.slot_capacity and route.capacity.
      let routeWeekdayCap = {};
      try { routeWeekdayCap = JSON.parse(r.weekday_capacity || "{}") || {}; } catch (e) { routeWeekdayCap = {}; }
      let ovDateSlot = null, ovDateWide = null;
      (overrides[r.id] || []).forEach((o) => {
        if (o.date !== p.date) return;
        try {
          const pay = o.payload ? JSON.parse(o.payload) : null;
          if (o.action === "slot_capacity_override" && pay && pay[p.slot] != null) ovDateSlot = pay[p.slot];
          if (o.action === "capacity_override" && pay && pay.capacity != null) ovDateWide = pay.capacity;
        } catch (e) { /* noop */ }
      });
      const weekdayCap = routeWeekdayCap[String(isoWeekdayOf(p.date))];
      const cap = ovDateSlot != null ? ovDateSlot
        : ovDateWide != null ? ovDateWide
        : routeSlots[p.slot] != null ? routeSlots[p.slot]
        : weekdayCap != null ? weekdayCap
        : r.capacity;
      const used = bookings.reduce((a, b) =>
        (b.route_id === p.route_id && b.date === p.date && b.slot === p.slot &&
          (b.status === "confirmed" || b.status === "confirmed_conflict" || b.status === "hold")) ? a + b.party : a, 0);
      if (used + p.party > cap) {
        return json({ error: "sold_out", message: "only " + Math.max(0, cap - used) + " seat(s) left for that date/slot" }, 409);
      }
      const booking = {
        id: "b_manual" + (seq++).toString(36),
        route_id: r.id, route_name: r.name, city: r.city,
        date: p.date, slot: p.slot, party: p.party,
        name: p.name, email: String(p.email).toLowerCase(), phone: p.phone || null,
        locale: p.locale === "nl" ? "nl" : "en",
        marketing_opt_in: p.marketing_opt_in ? 1 : 0,
        status: "confirmed", source: "manual",
        payment_status: p.payment_status || "paid_invoice",
        discount_code: p.discount_code || null,
        discount_cents: p.discount_cents || 0,
        stripe_session: null,
        created_at: new Date().toISOString(),
        hold_expires: null
      };
      bookings.push(booking);
      return json({ booking }, 201);
    }

    // bookings list
    if (path === "/admin/api/bookings" && method === "GET") {
      let list = bookings.slice();
      if (q.get("route")) list = list.filter((b) => b.route_id === q.get("route"));
      if (q.get("city")) list = list.filter((b) => b.city === q.get("city"));
      if (q.get("status")) list = list.filter((b) => b.status === q.get("status"));
      if (q.get("date_from")) list = list.filter((b) => b.date >= q.get("date_from"));
      if (q.get("date_to")) list = list.filter((b) => b.date <= q.get("date_to"));
      if (q.get("q")) { const s = q.get("q").toLowerCase(); list = list.filter((b) => b.name.toLowerCase().indexOf(s) >= 0 || b.email.toLowerCase().indexOf(s) >= 0); }
      return json({ bookings: list, total: list.length });
    }

    // participants per hour
    if (path === "/admin/api/participants-per-hour" && method === "GET") {
      const date = q.get("date"), route = q.get("route");
      const agg = {};
      bookings.forEach((b) => {
        if (b.date !== date) return;
        if (route && b.route_id !== route) return;
        if (!(b.status === "confirmed" || b.status === "confirmed_conflict" || b.status === "hold")) return;
        const key = b.route_id + "|" + b.slot;
        agg[key] = agg[key] || { route_id: b.route_id, route_name: b.route_name, slot: b.slot, guests: 0, bookings: 0 };
        agg[key].guests += b.party; agg[key].bookings += 1;
      });
      return json({ date, rows: Object.values(agg) });
    }

    // CSV
    if (path === "/admin/api/bookings.csv") {
      let list = bookings.slice();
      if (q.get("route")) list = list.filter((b) => b.route_id === q.get("route"));
      if (q.get("city")) list = list.filter((b) => b.city === q.get("city"));
      if (q.get("status")) list = list.filter((b) => b.status === q.get("status"));
      if (q.get("date_from")) list = list.filter((b) => b.date >= q.get("date_from"));
      if (q.get("date_to")) list = list.filter((b) => b.date <= q.get("date_to"));
      const cols = ["id", "route_name", "city", "date", "slot", "party", "name", "email", "phone", "status", "source", "payment_status", "discount_code", "discount_cents", "stripe_session", "created_at"];
      const esc = (v) => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const csv = [cols.join(",")].concat(list.map((b) => cols.map((c) => esc(b[c])).join(","))).join("\n");
      return Promise.resolve(new Response(csv, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8" } }));
    }

    // gift cards (migrations/0018/0019)
    if (path === "/admin/api/gift-cards" && method === "GET") {
      const sorted = giftCards.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return json({ gift_cards: sorted });
    }
    if ((m = match(path, /^\/admin\/api\/gift-cards\/([^/]+)\/void$/)) && method === "POST") {
      const code = decodeURIComponent(m[1]);
      const card = giftCards.find((c) => c.code === code);
      if (!card || card.status !== "active") return json({ error: "not_found" }, 404);
      card.status = "void";
      return json({ ok: true });
    }

    return json({ error: "not_found", message: "mock: no handler for " + method + " " + path }, 404);
  };

  // banner so it's obvious this is the offline preview
  window.addEventListener("DOMContentLoaded", function () {
    const b = document.createElement("div");
    b.textContent = "PREVIEW · sample data · any token signs you in";
    b.style.cssText = "position:fixed;bottom:10px;left:10px;z-index:500;background:#3f2b21;color:#ffd9c4;font:600 11px -apple-system,sans-serif;padding:6px 12px;border-radius:999px;letter-spacing:.04em;box-shadow:0 6px 18px rgba(0,0,0,.25);pointer-events:none;";
    document.body.appendChild(b);
  });
})();
