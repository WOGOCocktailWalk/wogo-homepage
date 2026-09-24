/* ==========================================================================
   WOGO Admin — client application (vanilla JS, zero dependencies)
   Talks to the Worker's /admin/api/* endpoints. Same file runs when the
   Worker serves it and inside preview/admin.html (where fetch is mocked).
   ========================================================================== */
(function () {
  "use strict";

  /* ---------- tiny DOM helper ------------------------------------------- */
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "html") n.innerHTML = v;
        else if (k === "text") n.textContent = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2), v);
        else if (k === "dataset") for (const d in v) n.dataset[d] = v[d];
        else n.setAttribute(k, v);
      }
    }
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null || c === false) continue;
        n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
      }
    }
    return n;
  }
  const $ = (s, r) => (r || document).querySelector(s);
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

  /* ---------- constants ------------------------------------------------- */
  const API = "";                       // same-origin; Worker serves both
  const CAT = ["--cat-1", "--cat-2", "--cat-3", "--cat-4", "--cat-5", "--cat-6"];
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];   // ISO Mon=1
  const DOW_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const STATUSES = ["confirmed", "hold", "cancelled", "expired", "confirmed_conflict"];

  /* ---------- state ----------------------------------------------------- */
  const S = {
    view: "bookings",
    routes: [],
    routeColor: {},                     // route_id -> css var
    bookings: { list: [], mode: "list", filters: {}, calMonth: null, page: 0, per: 50 },
    week: { start: null, loadedStart: null, bookings: [], overrides: {}, show: {}, showInit: false, mini: null },
    customers: { list: [], q: "", codes: {}, codesLoaded: false, loaded: false, formOpen: false },
    hours: { date: todayStr(), route: "", _data: null, editSlot: null },
    routesUI: { openId: null, tab: "details", bars: {}, overrides: {} },
    giftCards: { list: [], loaded: false }
  };

  /* ---------- date utils (timezone-safe, local) ------------------------- */
  function todayStr() { return dstr(new Date()); }
  function dstr(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function parseD(s) { const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { const d = parseD(s); d.setDate(d.getDate() + n); return dstr(d); }
  function mondayOf(s) { const d = parseD(s); d.setDate(d.getDate() - (isoDow(s) - 1)); return dstr(d); }
  function isoDow(s) { const d = parseD(s).getDay(); return d === 0 ? 7 : d; }   // Mon=1..Sun=7
  function prettyDate(s) {
    const d = parseD(s);
    return DOW[isoDow(s) - 1] + " " + d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3);
  }
  function euros(cents) { return "€" + (cents / 100).toFixed(2).replace(".", ","); }

  /* ---------- fetch layer ----------------------------------------------- */
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ "Accept": "application/json" }, opts.headers || {});
    if (opts.body != null && typeof opts.body !== "string") {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    if (opts.method && opts.method !== "GET") headers["X-Requested-With"] = "wogo-admin";
    const res = await fetch(API + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body,
      credentials: "same-origin"
    });
    if (res.status === 401) { showLogin(); throw new Error("unauthenticated"); }
    if (!res.ok) {
      let msg = "Request failed (" + res.status + ")";
      try { const j = await res.json(); if (j && j.message) msg = j.message; } catch (e) { /* noop */ }
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") || "";
    return ct.indexOf("application/json") >= 0 ? res.json() : res.text();
  }

  /* ---------- toast ----------------------------------------------------- */
  function toast(msg, kind) {
    const t = el("div", { class: "toast" + (kind ? " " + kind : ""), text: msg });
    $("#toasts").appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 320); }, 2600);
  }

  /* ---------- auth ------------------------------------------------------ */
  function showLogin() {
    $("#app-view").classList.remove("show");
    $("#login-view").style.display = "grid";
    setTimeout(() => { const i = $("#admin-token"); if (i) i.focus(); }, 60);
  }
  function showApp() {
    $("#login-view").style.display = "none";
    $("#app-view").classList.add("show");
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#login-btn"), errBox = $("#login-error");
    const token = $("#admin-token").value.trim();
    errBox.classList.remove("show");
    if (!token) return;
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      await api("/admin/login", { method: "POST", body: { token } });
      $("#admin-token").value = "";
      await boot();
    } catch (err) {
      errBox.textContent = err.message === "unauthenticated" ? "That token isn’t right. Check and try again." : err.message;
      errBox.classList.add("show");
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });

  $("#logout-btn").addEventListener("click", async () => {
    try { await api("/admin/logout", { method: "POST" }); } catch (e) { /* noop */ }
    showLogin();
  });

  /* ---------- navigation ------------------------------------------------ */
  const NAV = document.querySelectorAll(".nav-item[data-view]");
  NAV.forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
  $("#menu-btn").addEventListener("click", () => $("#sidebar").classList.add("open"));
  $("#sidebar-scrim").addEventListener("click", () => $("#sidebar").classList.remove("open"));

  function go(view) {
    S.view = view;
    NAV.forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $("#sidebar").classList.remove("open");
    $("#topbar-actions").innerHTML = "";
    const titles = {
      bookings: ["Bookings", "Every walk booked, across all cities and routes"],
      customers: ["Customers", "Who books with you, how often, and what they spend"],
      hours: ["Participants per hour", "Who is arriving, and when — pick a date"],
      routes: ["Route manager", "Days, times, seats, bars and one-off date changes"],
      giftcards: ["Gift cards", "Every card sold, its balance, and who it's for"],
      export: ["Export", "Download bookings as a spreadsheet (CSV)"]
    };
    $("#page-title").textContent = titles[view][0];
    $("#page-sub").textContent = titles[view][1];
    const target = $("#view");
    clear(target);
    if (view === "bookings") renderBookings(target);
    else if (view === "customers") renderCustomers(target);
    else if (view === "hours") renderHours(target);
    else if (view === "routes") renderRoutes(target);
    else if (view === "giftcards") renderGiftCards(target);
    else if (view === "export") renderExport(target);
  }

  /* ---------- shared: route color + dot ---------------------------------- */
  function assignColors() {
    S.routes.forEach((r, i) => { if (!S.routeColor[r.id]) S.routeColor[r.id] = CAT[i % CAT.length]; });
  }
  function dot(routeId) {
    return el("span", { class: "dot", style: "background:var(" + (S.routeColor[routeId] || "--cat-3") + ")" });
  }
  function routeById(id) { return S.routes.find((r) => r.id === id); }
  function cities() {
    const set = []; S.routes.forEach((r) => { if (set.indexOf(r.city) < 0) set.push(r.city); });
    return set.sort();
  }

  /* ======================================================================
     VIEW 1 — BOOKINGS
     ====================================================================== */
  function renderBookings(root) {
    clear(root);
    if (S.bookings.mode === "week") { renderWeek(root); return; }
    const f = S.bookings.filters;

    // ---- filter bar ----
    const routeChips = el("div", { class: "chips" });
    routeChips.appendChild(chip("All routes", !f.route, dot("--none"), () => { delete f.route; loadBookings(); }, true));
    S.routes.forEach((r) => {
      routeChips.appendChild(chip(r.name.replace(/^WOGO Cocktail Walk /, "").replace(/^Rotterdam /, "R· "),
        f.route === r.id, dot(r.id), () => { f.route = r.id; loadBookings(); }));
    });

    const citySel = selectField("City", "", ["Any city"].concat(cities()), (v) => {
      if (v === "Any city") delete f.city; else f.city = v; loadBookings();
    }, f.city || "Any city");
    const statusSel = selectField("Status", "", ["Any status"].concat(STATUSES.map(prettyStatus)), (v) => {
      if (v === "Any status") delete f.status; else f.status = STATUSES[["Any status"].concat(STATUSES.map(prettyStatus)).indexOf(v) - 1];
      loadBookings();
    }, f.status ? prettyStatus(f.status) : "Any status");
    const fromF = dateField("From", f.date_from || "", (v) => { if (v) f.date_from = v; else delete f.date_from; loadBookings(); });
    const toF = dateField("To", f.date_to || "", (v) => { if (v) f.date_to = v; else delete f.date_to; loadBookings(); });

    const searchInput = el("input", { type: "text", placeholder: "Name or email…", value: f.q || "" });
    let sT;
    searchInput.addEventListener("input", () => { clearTimeout(sT); sT = setTimeout(() => { const v = searchInput.value.trim(); if (v) f.q = v; else delete f.q; loadBookings(); }, 320); });
    const searchF = el("div", { class: "filter-group search" }, [el("label", { text: "Search" }), searchInput]);

    const seg = el("div", { class: "seg" }, [
      segBtn("List", S.bookings.mode === "list", () => { S.bookings.mode = "list"; renderBookings(root); }),
      segBtn("Week", false, () => { S.bookings.mode = "week"; renderBookings(root); }),
      segBtn("Month", S.bookings.mode === "cal", () => { S.bookings.mode = "cal"; renderBookings(root); })
    ]);
    const clearBtn = el("button", { class: "btn btn-quiet btn-sm", text: "Clear", onclick: () => { S.bookings.filters = {}; renderBookings(root); loadBookings(); } });

    const filters = el("div", { class: "filters" }, [
      el("div", { class: "filters-row", style: "margin-bottom:12px" }, [
        el("div", { class: "filter-group", style: "flex:1" }, [el("label", { text: "Route" }), routeChips])
      ]),
      el("div", { class: "filters-row" }, [
        citySel, statusSel, fromF, toF, searchF,
        el("div", { class: "filter-actions" }, [seg, clearBtn])
      ])
    ]);
    root.appendChild(filters);

    const stats = el("div", { class: "stat-row", id: "bk-stats" });
    root.appendChild(stats);

    const holder = el("div", { id: "bk-holder" });
    root.appendChild(holder);

    if (S.bookings.list.length === 0) loadBookings();
    else paintBookings();
  }

  async function loadBookings() {
    const holder = $("#bk-holder");
    if (!holder) return;
    clear(holder);
    holder.appendChild(skeletonCard());
    try {
      const qs = new URLSearchParams();
      const f = S.bookings.filters;
      for (const k in f) qs.set(k, f[k]);
      qs.set("limit", "500");
      const data = await api("/admin/api/bookings?" + qs.toString());
      S.bookings.list = data.bookings || [];
      paintBookings();
    } catch (e) {
      if (e.message !== "unauthenticated") { clear(holder); holder.appendChild(errorCard(e.message, loadBookings)); }
    }
  }

  function paintBookings() {
    paintStats();
    const holder = $("#bk-holder");
    if (!holder) return;
    clear(holder);
    holder.appendChild(S.bookings.mode === "cal" ? bookingsCalendar() : bookingsTable());
  }

  function paintStats() {
    const box = $("#bk-stats");
    if (!box) return;
    clear(box);
    const list = S.bookings.list;
    let guests = 0, revenue = 0, confirmed = 0, holds = 0;
    list.forEach((b) => {
      const counts = b.status === "confirmed" || b.status === "confirmed_conflict";
      if (counts) {
        guests += b.party; confirmed++;
        const r = routeById(b.route_id);
        const unpaid = b.payment_status === "free" || b.payment_status === "comp";
        if (r && !unpaid) revenue += Math.max(0, r.price_cents * b.party - (b.discount_cents || 0));
      }
      if (b.status === "hold") holds++;
    });
    box.appendChild(stat("Bookings", list.length, "in current filter"));
    box.appendChild(stat("Guests (confirmed)", guests, confirmed + " confirmed bookings"));
    box.appendChild(stat("Revenue (confirmed)", euros(revenue), "gross, ex. Stripe fees"));
    box.appendChild(stat("Active holds", holds, "paying right now"));
  }

  function bookingsTable() {
    const list = S.bookings.list.slice().sort((a, b) =>
      (b.date + b.slot).localeCompare(a.date + a.slot));
    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "card-head" }, [
      el("h2", { text: "All bookings" }),
      el("span", { class: "count-badge", text: list.length + " rows" })
    ]));
    if (list.length === 0) {
      card.appendChild(el("div", { class: "empty" }, [
        el("div", { class: "big", text: "☕" }),
        el("div", { text: "No bookings match these filters yet." })
      ]));
      return card;
    }
    const scroll = el("div", { class: "table-scroll" });
    const t = el("table", { class: "data" });
    t.appendChild(el("thead", {}, el("tr", {}, [
      th("When"), th("Route"), th("City"), th("Guest"), th("Party"), th("Status"), th("Booked")
    ])));
    const tb = el("tbody");
    list.forEach((b) => {
      const r = routeById(b.route_id);
      const tr = el("tr", { onclick: () => openDrawer(b) }, [
        el("td", {}, [el("div", { class: "td-name num", text: prettyDate(b.date) }), el("div", { class: "td-sub num", text: b.slot })]),
        el("td", {}, el("span", { class: "route-tag" }, [dot(b.route_id), shortRoute(b.route_name || (r && r.name) || b.route_id)])),
        el("td", { class: "td-sub", text: b.city || (r && r.city) || "" }),
        el("td", {}, [el("div", { class: "td-name", text: b.name }), el("div", { class: "td-sub", text: b.email })]),
        el("td", { class: "num", text: b.party }),
        el("td", {}, el("div", { class: "badge-stack" }, [
          badge(b.status),
          b.source === "manual" ? el("span", { class: "tag-mini src", text: "Manual" }) : null,
          (b.discount_code || b.discount_cents > 0) ? el("span", { class: "tag-mini disc", text: (b.discount_code || "discount") + " −" + euros(b.discount_cents || 0) }) : null
        ].filter(Boolean))),
        el("td", { class: "td-sub num", text: (b.created_at || "").slice(0, 10) })
      ]);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    scroll.appendChild(t);
    card.appendChild(scroll);
    return card;
  }

  function bookingsCalendar() {
    const card = el("div", { class: "card" });
    let month = S.bookings.calMonth || todayStr().slice(0, 7);
    const [yy, mm] = month.split("-").map(Number);

    const head = el("div", { class: "cal-head" });
    head.appendChild(el("h2", { text: MONTHS[mm - 1] + " " + yy }));
    head.appendChild(el("div", { class: "cal-nav" }, [
      el("button", { class: "icon-btn", "aria-label": "Previous month", text: "‹", onclick: () => { S.bookings.calMonth = shiftMonth(month, -1); paintBookings(); } }),
      el("button", { class: "icon-btn", "aria-label": "Next month", text: "›", onclick: () => { S.bookings.calMonth = shiftMonth(month, 1); paintBookings(); } })
    ]));
    head.appendChild(el("div", { class: "grow" }));
    head.appendChild(el("div", { class: "legend" }, S.routes.map((r) =>
      el("span", { class: "legend-item" }, [el("span", { class: "sw", style: "background:var(" + S.routeColor[r.id] + ")" }), shortRoute(r.name)]))));
    card.appendChild(head);

    // aggregate guests per day per route
    const byDay = {};
    S.bookings.list.forEach((b) => {
      if (b.date.slice(0, 7) !== month) return;
      if (!(b.status === "confirmed" || b.status === "confirmed_conflict" || b.status === "hold")) return;
      (byDay[b.date] = byDay[b.date] || {});
      byDay[b.date][b.route_id] = (byDay[b.date][b.route_id] || 0) + b.party;
    });

    const grid = el("div", { class: "cal-grid" });
    DOW.forEach((d) => grid.appendChild(el("div", { class: "cal-dow", text: d })));
    const first = new Date(yy, mm - 1, 1);
    const startPad = (first.getDay() === 0 ? 7 : first.getDay()) - 1;
    const daysInMonth = new Date(yy, mm, 0).getDate();
    for (let i = 0; i < startPad; i++) grid.appendChild(el("div", { class: "cal-cell blank" }));
    for (let day = 1; day <= daysInMonth; day++) {
      const ds = month + "-" + String(day).padStart(2, "0");
      const routeGuests = byDay[ds] || {};
      const total = Object.values(routeGuests).reduce((a, c) => a + c, 0);
      const maxDay = Math.max(1, ...Object.values(byDay).map((o) => Object.values(o).reduce((a, c) => a + c, 0)));
      const cell = el("div", { class: "cal-cell" + (ds === todayStr() ? " today" : ""), onclick: () => drillDay(ds) });
      cell.appendChild(el("div", { class: "cal-date", text: String(day) }));
      if (total > 0) {
        const bars = el("div", { class: "cal-bars" });
        Object.keys(routeGuests).forEach((rid) => {
          bars.appendChild(el("div", { class: "cb", style: "background:var(" + (S.routeColor[rid] || "--cat-3") + ");flex:" + routeGuests[rid] }));
        });
        cell.appendChild(bars);
        cell.appendChild(el("div", { class: "cal-guests", text: total + " guest" + (total === 1 ? "" : "s") }));
      }
      grid.appendChild(cell);
    }
    card.appendChild(grid);
    return card;
  }

  function drillDay(ds) {
    S.bookings.filters.date_from = ds;
    S.bookings.filters.date_to = ds;
    S.bookings.mode = "list";
    renderBookings($("#view"));
    loadBookings();
  }

  /* ---------- drawer ---------------------------------------------------- */
  // Shared post-mutation refresh for Move/Cancel (and anything else that
  // changes a booking's date/slot/status from the drawer). openDrawer() is
  // reachable from three different places — the bookings list/month view,
  // the Week time-grid (a totally different render path, no #bk-holder in
  // its DOM), and the Customers drawer — so this can't just call
  // loadBookings() directly (it no-ops with no #bk-holder, silently leaving
  // the Week grid showing the stale pre-move/cancel state). Same
  // invalidate-caches-then-re-render-if-visible pattern the customer-edit
  // save already uses (see openCustomerDrawer's "Save changes" handler).
  function refreshAfterBookingMutation() {
    S.bookings.list = [];      // list/month view refetches on next visit
    S.week.loadedStart = null; // week grid refetches on next visit
    if (S.view === "bookings") renderBookings($("#view")); // repaint now if it's on screen
  }
  function openDrawer(b) {
    const r = routeById(b.route_id);
    $("#drawer-title").textContent = b.name;
    const body = $("#drawer-body");
    clear(body);
    const kv = el("dl", { class: "kv" });
    const rows = [
      ["Status", null, badge(b.status)],
      ["Route", (b.route_name || (r && r.name) || b.route_id)],
      ["City", (b.city || (r && r.city) || "—")],
      ["Date", prettyDate(b.date) + " (" + b.date + ")"],
      ["Time", b.slot],
      ["Party size", b.party + " guest" + (b.party === 1 ? "" : "s")],
      ["Price", r ? euros(r.price_cents * b.party) + "  (" + euros(r.price_cents) + " pp)" : "—"],
      (b.discount_code || b.discount_cents > 0)
        ? ["Discount", (b.discount_code ? b.discount_code + " · " : "") + "−" + euros(b.discount_cents || 0) + (r ? "  → paid " + euros(Math.max(0, r.price_cents * b.party - (b.discount_cents || 0))) : "")]
        : null,
      ["Source", b.source === "manual" ? "Manual (phone booking)" : "Website"],
      b.payment_status ? ["Payment", prettyPayment(b.payment_status)] : null,
      ["Email", b.email],
      ["Phone", b.phone || "—"],
      b.notes ? ["⚠️ Allergies / notes", b.notes] : null,
      ["Language", (b.locale || "en").toUpperCase()],
      ["Marketing", b.marketing_opt_in ? "Opted in" : "No"],
      ["Booking ID", b.id, null, "mono"],
      ["Stripe session", b.stripe_session || "—", null, "mono"],
      ["Created", b.created_at || "—"]
    ];
    rows.filter(Boolean).forEach((row) => {
      kv.appendChild(el("dt", { text: row[0] }));
      if (row[2]) kv.appendChild(el("dd", {}, row[2]));
      else kv.appendChild(el("dd", { class: row[3] || "", text: row[1] }));
    });
    body.appendChild(kv);

    // "Move" and "Cancel" are only meaningful for a booking that's actually
    // holding a seat — a hold/expired/already-cancelled row has nothing to
    // move or free.
    const movable = b.status === "confirmed" || b.status === "confirmed_conflict";
    const moveWrap = el("div", { class: "inline-form", style: "display:none;margin-top:16px" });
    const cancelWrap = el("div", { style: "display:none;margin-top:16px" });

    if (movable) {
      // -- Move booking: new date + a slot picker from the route's own times.
      const dateI = el("input", { type: "date", value: b.date });
      const slotSel = el("select");
      let rawSlots = [];
      try { rawSlots = JSON.parse((r && r.slots) || "[]"); } catch (e) { rawSlots = []; }
      const perWeekday = !!(rawSlots && typeof rawSlots === "object" && !Array.isArray(rawSlots));
      function paintMoveSlotOptions() {
        const opts = perWeekday ? (rawSlots[String(isoDow(dateI.value || b.date))] || []).slice()
          : (Array.isArray(rawSlots) ? rawSlots.slice() : []);
        // Same-times-every-day routes always keep the booking's own slot in
        // the list, exactly as before this feature. Per-weekday routes only
        // force it in while still viewing the booking's original date — a
        // new date shows THAT day's real offerings.
        if (!perWeekday || dateI.value === b.date) {
          if (!opts.includes(b.slot)) opts.push(b.slot);
        }
        clear(slotSel);
        opts.sort().forEach((s) => slotSel.appendChild(el("option", { value: s, text: s })));
        slotSel.value = opts.includes(b.slot) ? b.slot : (opts[0] || "");
      }
      paintMoveSlotOptions();
      if (perWeekday) dateI.addEventListener("change", paintMoveSlotOptions);
      const moveErr = el("div", { class: "form-error", role: "alert", "aria-live": "assertive" });
      moveWrap.appendChild(el("div", { class: "subhead", text: "Move to a new date/time" }));
      moveWrap.appendChild(moveErr);
      moveWrap.appendChild(el("div", { class: "field" }, [el("label", { text: "New date" }), dateI]));
      moveWrap.appendChild(el("div", { class: "field" }, [el("label", { text: "New start time" }), slotSel]));
      moveWrap.appendChild(el("div", { class: "rc-actions" }, [
        el("button", { class: "btn btn-ghost btn-sm", text: "Never mind", onclick: () => { moveWrap.style.display = "none"; } }),
        el("div", { class: "grow" }),
        el("button", { class: "btn btn-primary btn-sm", text: "Confirm move", onclick: async (ev) => {
          moveErr.classList.remove("show");
          if (!dateI.value) { moveErr.textContent = "Pick a date."; moveErr.classList.add("show"); return; }
          const btn = ev.currentTarget;
          btn.disabled = true; btn.textContent = "Moving…";
          try {
            await api("/admin/api/bookings/" + b.id + "/reschedule", { method: "POST", body: { date: dateI.value, slot: slotSel.value } });
            toast("Booking moved — guest and bars emailed", "ok");
            closeDrawer();
            refreshAfterBookingMutation();
          } catch (e) {
            moveErr.textContent = e.message; moveErr.classList.add("show");
            btn.disabled = false; btn.textContent = "Confirm move";
          }
        } })
      ]));
      body.appendChild(moveWrap);

      // -- Cancel booking: a deliberate second step (reveal → explicit
      //    "Yes, cancel booking" click) rather than a native confirm() popup,
      //    with an optional note the guest email can carry (e.g. refund
      //    wording) — refunds themselves stay a manual Stripe action.
      const noteI = el("textarea", { rows: "3", maxlength: "2000", placeholder: "e.g. “Refund of €30 is on its way.”" });
      const cancelErr = el("div", { class: "form-error", role: "alert", "aria-live": "assertive" });
      cancelWrap.appendChild(el("div", { class: "subhead", text: "Cancel this booking" }));
      cancelWrap.appendChild(el("p", { class: "capacity-hint", style: "padding:0;margin:0 0 10px", text: "Frees the seats and emails the guest and every bar on the route. Refunds are NOT automatic — handle those yourself in Stripe." }));
      cancelWrap.appendChild(cancelErr);
      cancelWrap.appendChild(el("div", { class: "field" }, [el("label", { text: "Optional note to the guest — e.g. refund wording" }), noteI]));
      cancelWrap.appendChild(el("div", { class: "rc-actions" }, [
        el("button", { class: "btn btn-ghost btn-sm", text: "Never mind", onclick: () => { cancelWrap.style.display = "none"; } }),
        el("div", { class: "grow" }),
        el("button", { class: "btn btn-danger btn-sm", text: "Yes, cancel booking", onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true; btn.textContent = "Cancelling…";
          try {
            await api("/admin/api/bookings/" + b.id + "/cancel", { method: "POST", body: { message: noteI.value.trim() || undefined } });
            toast("Booking cancelled — guest and bars emailed", "ok");
            closeDrawer();
            refreshAfterBookingMutation();
          } catch (e) {
            cancelErr.textContent = e.message; cancelErr.classList.add("show");
            btn.disabled = false; btn.textContent = "Yes, cancel booking";
          }
        } })
      ]));
      body.appendChild(cancelWrap);
    }

    const foot = $("#drawer-foot");
    clear(foot);
    foot.appendChild(el("button", {
      class: "btn btn-quiet", text: "Resend confirmation",
      onclick: async () => {
        try { await api("/admin/api/bookings/" + b.id + "/resend", { method: "POST" }); toast("Confirmation re-sent to " + b.email, "ok"); }
        catch (e) { toast(e.message, "err"); }
      }
    }));
    if (movable) {
      foot.appendChild(el("button", {
        class: "btn btn-quiet", text: "Move booking",
        onclick: () => {
          cancelWrap.style.display = "none";
          moveWrap.style.display = moveWrap.style.display === "none" ? "block" : "none";
          if (moveWrap.style.display === "block") moveWrap.scrollIntoView({ block: "nearest" });
        }
      }));
      foot.appendChild(el("button", {
        class: "btn btn-danger", text: "Cancel booking",
        onclick: () => {
          moveWrap.style.display = "none";
          cancelWrap.style.display = cancelWrap.style.display === "none" ? "block" : "none";
          if (cancelWrap.style.display === "block") cancelWrap.scrollIntoView({ block: "nearest" });
        }
      }));
    }
    foot.appendChild(el("button", { class: "btn btn-ghost", text: "Close", onclick: closeDrawer }));

    $("#drawer").classList.add("show");
    $("#drawer").setAttribute("aria-hidden", "false");
    $("#drawer-scrim").classList.add("show");
  }
  function closeDrawer() {
    $("#drawer").classList.remove("show");
    $("#drawer").setAttribute("aria-hidden", "true");
    $("#drawer-scrim").classList.remove("show");
  }
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); $("#sidebar").classList.remove("open"); } });

  /* ======================================================================
     VIEW 1b — WEEK TIME-GRID
     Mon–Sun columns × hour rows; every departure is one block coloured by
     route, with a booked/capacity pill (green = open, amber = 70%+, full).
     Click a block for that departure's guest list. Sidebar: mini month
     picker, route filter with colour key, upcoming departures.
     ====================================================================== */
  function renderWeek(root) {
    const wk = S.week;
    if (!wk.start) wk.start = mondayOf(todayStr());
    if (!wk.showInit) { S.routes.forEach((r) => { wk.show[r.id] = true; }); wk.showInit = true; }
    if (!wk.mini) wk.mini = wk.start.slice(0, 7);

    const seg = el("div", { class: "seg" }, [
      segBtn("List", false, () => { S.bookings.mode = "list"; renderBookings(root); }),
      segBtn("Week", true, () => { /* already here */ }),
      segBtn("Month", false, () => { S.bookings.mode = "cal"; renderBookings(root); })
    ]);
    root.appendChild(el("div", { class: "wk-head" }, [
      el("div", { class: "cal-nav" }, [
        el("button", { class: "icon-btn", "aria-label": "Previous week", text: "‹", onclick: () => shiftWeek(-7) }),
        el("button", { class: "icon-btn", "aria-label": "Next week", text: "›", onclick: () => shiftWeek(7) })
      ]),
      el("button", { class: "btn btn-quiet btn-sm", text: "This week", onclick: () => { wk.start = mondayOf(todayStr()); wk.mini = wk.start.slice(0, 7); renderBookings($("#view")); } }),
      el("h2", { class: "wk-title", text: weekLabel(wk.start) }),
      el("div", { class: "grow" }),
      seg
    ]));

    root.appendChild(el("div", { class: "wk-layout" }, [
      el("aside", { class: "wk-side", "aria-label": "Week filters" }, [miniMonthCard(), routeFilterCard(), el("div", { id: "wk-upcoming" })]),
      el("div", { class: "wk-main", id: "wk-holder" }, skeletonCard())
    ]));

    if (wk.loadedStart === wk.start) paintWeek();
    else loadWeek();
  }
  function shiftWeek(days) { S.week.start = addDays(S.week.start, days); S.week.mini = S.week.start.slice(0, 7); renderBookings($("#view")); }
  function weekLabel(start) {
    const a = parseD(start), b = parseD(addDays(start, 6));
    const am = MONTHS[a.getMonth()].slice(0, 3), bm = MONTHS[b.getMonth()].slice(0, 3);
    return a.getDate() + (am === bm ? "" : " " + am) + " – " + b.getDate() + " " + bm + " " + b.getFullYear();
  }

  async function loadWeek() {
    const wk = S.week;
    try {
      const qs = new URLSearchParams({ date_from: wk.start, date_to: addDays(wk.start, 6), limit: "500" });
      const results = await Promise.all([
        api("/admin/api/bookings?" + qs.toString()),
        Promise.all(S.routes.map((r) =>
          api("/admin/api/date-overrides?route=" + encodeURIComponent(r.id))
            .then((d) => [r.id, d.overrides || []])
            .catch(() => [r.id, []])))
      ]);
      wk.bookings = results[0].bookings || [];
      wk.overrides = {};
      results[1].forEach((pair) => { wk.overrides[pair[0]] = pair[1]; });
      wk.loadedStart = wk.start;
      paintWeek();
    } catch (e) {
      if (e.message !== "unauthenticated") {
        const h = $("#wk-holder");
        if (h) { clear(h); h.appendChild(errorCard(e.message, loadWeek)); }
      }
    }
  }

  // One entry per (day, route, slot): every scheduled departure that week,
  // PLUS any off-schedule departure that has bookings (manual bookings may
  // sit outside open_days on purpose — the owner overrode the rules by hand).
  function weekDeps() {
    const wk = S.week, deps = [];
    for (let i = 0; i < 7; i++) {
      const ds = addDays(wk.start, i);
      S.routes.forEach((r) => {
        if (!wk.show[r.id]) return;
        const ov = overridesForDate(wk.overrides[r.id] || [], ds);
        let openDays = [];
        try { openDays = JSON.parse(r.open_days || "[]"); } catch (e) { openDays = []; }
        const scheduled = (!ov.closed && r.active && openDays.indexOf(isoDow(ds)) >= 0) ? dateSlots(r, ov, ds) : [];
        const bySlot = {};
        wk.bookings.forEach((b) => {
          if (b.route_id !== r.id || b.date !== ds) return;
          if (!(b.status === "confirmed" || b.status === "confirmed_conflict" || b.status === "hold")) return;
          (bySlot[b.slot] = bySlot[b.slot] || []).push(b);
        });
        const slots = scheduled.slice();
        Object.keys(bySlot).forEach((s) => { if (slots.indexOf(s) < 0) slots.push(s); });
        slots.sort().forEach((slot) => {
          const cap = slotCapInfo(r, ov, slot).effective;
          const list = (bySlot[slot] || []).slice().sort((a, b2) => a.name.localeCompare(b2.name));
          const booked = list.reduce((a, b2) => a + b2.party, 0);
          if (cap === 0 && booked === 0) return;   // closed and empty — not a departure
          const state = (cap === 0 || booked >= cap) ? "full" : (booked / cap >= 0.7 ? "amber" : "open");
          deps.push({ date: ds, dayIdx: i, slot, route: r, cap, booked, list, state });
        });
      });
    }
    return deps;
  }

  function paintWeek() {
    const holder = $("#wk-holder");
    if (!holder) return;
    const deps = weekDeps();

    // hour rows ~14:00–23:00, stretched only if a departure falls outside
    let startH = 14, endH = 23;
    deps.forEach((d) => {
      const h = parseInt(d.slot.slice(0, 2), 10);
      if (h < startH) startH = h;
      if (h + 1 > endH) endH = h + 1;
    });

    clear(holder);
    const card = el("div", { class: "card" });
    const grid = el("div", { class: "wk-grid" });

    grid.appendChild(el("div", { class: "wk-corner" }));
    for (let i = 0; i < 7; i++) {
      const ds = addDays(S.week.start, i);
      grid.appendChild(el("div", { class: "wk-day" + (ds === todayStr() ? " today" : "") }, [
        el("span", { class: "wk-dow", text: DOW[i] }),
        el("span", { class: "wk-dnum", text: String(parseD(ds).getDate()) })
      ]));
    }

    // one row per half hour; departures stack inside their half-hour cell
    const cells = {};
    for (let h = startH; h < endH; h++) {
      for (let half = 0; half < 2; half++) {
        const t = String(h).padStart(2, "0") + ":" + (half ? "30" : "00");
        grid.appendChild(el("div", { class: "wk-time" + (half ? "" : " hr"), text: half ? "" : t }));
        for (let i = 0; i < 7; i++) {
          const cell = el("div", { class: "wk-cell" + (half ? "" : " hr") });
          cells[i + "|" + t] = cell;
          grid.appendChild(cell);
        }
      }
    }
    deps.forEach((dep) => {
      const mins = parseInt(dep.slot.slice(3, 5), 10);
      const cell = cells[dep.dayIdx + "|" + dep.slot.slice(0, 2) + ":" + (mins < 30 ? "00" : "30")];
      if (cell) cell.appendChild(depBlock(dep));
    });

    card.appendChild(el("div", { class: "wk-scroll" }, grid));
    card.appendChild(el("div", { class: "wk-key" }, [
      keySwatch("open", "Seats open"),
      keySwatch("amber", "Filling up (70%+)"),
      keySwatch("full", "Full"),
      el("span", { class: "legend-item", style: "color:var(--muted)", text: "Faded block = scheduled, nothing booked yet" })
    ]));
    holder.appendChild(card);
    paintUpcoming(deps);
  }
  function keySwatch(state, label) {
    return el("span", { class: "legend-item" }, [el("span", { class: "sw cap-" + state }), label]);
  }

  function depBlock(dep) {
    return el("button", {
      type: "button",
      class: "wk-dep" + (dep.booked === 0 ? " ghost" : ""),
      style: "border-left-color:var(" + (S.routeColor[dep.route.id] || "--cat-3") + ")",
      "aria-label": shortRoute(dep.route.name) + ", " + dep.route.city + ", " + prettyDate(dep.date) + " " + dep.slot + ", " + dep.booked + " of " + dep.cap + " seats booked",
      onclick: () => openDepartureDrawer(dep)
    }, [
      el("div", { class: "wk-dep-top" }, [
        dot(dep.route.id),
        el("span", { class: "wk-dep-name", text: shortRoute(dep.route.name) }),
        el("span", { class: "wk-pill " + dep.state, text: dep.booked + "/" + dep.cap })
      ]),
      el("div", { class: "wk-dep-sub", text: dep.slot + " · " + dep.route.city })
    ]);
  }

  function openDepartureDrawer(dep) {
    $("#drawer-title").textContent = shortRoute(dep.route.name) + " · " + dep.slot;
    const body = $("#drawer-body");
    clear(body);

    const left = Math.max(0, dep.cap - dep.booked);
    const pct = dep.cap > 0 ? Math.min(100, Math.round((dep.booked / dep.cap) * 100)) : 100;
    const fillClass = dep.state === "full" ? "full" : dep.state === "amber" ? "mid" : "low";
    body.appendChild(el("div", { class: "dep-summary" }, [
      el("div", { class: "td-name", text: prettyDate(dep.date) + " · " + dep.route.city }),
      el("div", { class: "cap-meter", style: "margin:10px 0 6px" },
        el("div", { class: "cap-fill " + fillClass, style: "width:" + pct + "%" })),
      el("div", { class: "cap-labels" }, [
        el("span", { class: "cap-count", text: dep.booked + " / " + dep.cap + " seats" }),
        el("span", { class: "cap-left", text: dep.cap === 0 ? "closed for this date" : left + " left" })
      ])
    ]));

    body.appendChild(el("div", { class: "subhead", text: "Guest list" }));
    if (dep.list.length === 0) {
      body.appendChild(el("p", { class: "capacity-hint", text: "No guests booked on this start time yet." }));
    } else {
      const listEl = el("div", { class: "dep-guests" });
      dep.list.forEach((b) => {
        listEl.appendChild(el("button", { type: "button", class: "dep-guest", onclick: () => openDrawer(b) }, [
          el("div", {}, [
            el("div", { class: "td-name", text: b.name }),
            el("div", { class: "td-sub", text: b.email })
          ]),
          el("div", { class: "dep-guest-right" }, [
            el("span", { class: "count-badge", text: b.party + " " + (b.party === 1 ? "guest" : "guests") }),
            badge(b.status)
          ])
        ]));
      });
      body.appendChild(listEl);
      body.appendChild(el("p", { class: "capacity-hint", text: "Tap a guest for the full booking — and to resend their confirmation." }));
    }

    const foot = $("#drawer-foot");
    clear(foot);
    foot.appendChild(el("button", { class: "btn btn-ghost", text: "Close", onclick: closeDrawer }));

    $("#drawer").classList.add("show");
    $("#drawer").setAttribute("aria-hidden", "false");
    $("#drawer-scrim").classList.add("show");
  }

  function miniMonthCard() {
    const wk = S.week;
    const [yy, mm] = wk.mini.split("-").map(Number);
    const card = el("div", { class: "side-card" });
    card.appendChild(el("div", { class: "side-head" }, [
      el("span", { class: "side-title", text: MONTHS[mm - 1] + " " + yy }),
      el("div", { class: "grow" }),
      el("button", { class: "icon-btn mini", "aria-label": "Previous month", text: "‹", onclick: () => { wk.mini = shiftMonth(wk.mini, -1); renderBookings($("#view")); } }),
      el("button", { class: "icon-btn mini", "aria-label": "Next month", text: "›", onclick: () => { wk.mini = shiftMonth(wk.mini, 1); renderBookings($("#view")); } })
    ]));
    const g = el("div", { class: "mini-cal" });
    DOW.forEach((d) => g.appendChild(el("span", { class: "mc-dow", text: d[0] })));
    const first = new Date(yy, mm - 1, 1);
    const pad = (first.getDay() === 0 ? 7 : first.getDay()) - 1;
    const days = new Date(yy, mm, 0).getDate();
    const weekEnd = addDays(wk.start, 6);
    for (let i = 0; i < pad; i++) g.appendChild(el("span", { class: "mc-day blank" }));
    for (let d = 1; d <= days; d++) {
      const ds = wk.mini + "-" + String(d).padStart(2, "0");
      g.appendChild(el("button", {
        type: "button",
        class: "mc-day" + (ds >= wk.start && ds <= weekEnd ? " sel" : "") + (ds === todayStr() ? " today" : ""),
        text: String(d),
        "aria-label": "Jump to week of " + ds,
        onclick: () => { wk.start = mondayOf(ds); wk.mini = wk.start.slice(0, 7); renderBookings($("#view")); }
      }));
    }
    card.appendChild(g);
    return card;
  }

  function routeFilterCard() {
    const wk = S.week;
    const card = el("div", { class: "side-card" });
    const allCb = el("input", { type: "checkbox" });
    allCb.checked = S.routes.every((r) => wk.show[r.id]);
    allCb.addEventListener("change", () => {
      S.routes.forEach((r) => { wk.show[r.id] = allCb.checked; });
      renderBookings($("#view"));
    });
    card.appendChild(el("div", { class: "side-head" }, [
      el("span", { class: "side-title", text: "Routes" }),
      el("div", { class: "grow" }),
      el("label", { class: "rf-all" }, [allCb, "All"])
    ]));
    const list = el("div", { class: "rf-list" });
    S.routes.forEach((r) => {
      const cb = el("input", { type: "checkbox" });
      cb.checked = !!wk.show[r.id];
      cb.addEventListener("change", () => {
        wk.show[r.id] = cb.checked;
        allCb.checked = S.routes.every((x) => wk.show[x.id]);
        paintWeek();
      });
      list.appendChild(el("label", { class: "rf-item" }, [
        cb,
        el("span", { class: "sw", style: "background:var(" + (S.routeColor[r.id] || "--cat-3") + ")" }),
        el("span", { class: "rf-name", text: shortRoute(r.name) }),
        el("span", { class: "rf-city", text: r.city })
      ]));
    });
    card.appendChild(list);
    return card;
  }

  function paintUpcoming(deps) {
    const holder = $("#wk-upcoming");
    if (!holder) return;
    clear(holder);
    const card = el("div", { class: "side-card" });
    card.appendChild(el("div", { class: "side-head" }, [el("span", { class: "side-title", text: "Upcoming start times" })]));
    const now = new Date();
    const nowT = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    const today = todayStr();
    const up = deps
      .filter((d) => d.date > today || (d.date === today && d.slot >= nowT))
      .sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot))
      .slice(0, 6);
    if (up.length === 0) {
      card.appendChild(el("p", { class: "capacity-hint", style: "padding:10px 14px 12px;margin:0", text: "Nothing left in this week — jump ahead with › or the month picker." }));
    } else {
      const list = el("div", { class: "up-list" });
      up.forEach((d) => {
        list.appendChild(el("button", { type: "button", class: "up-item", onclick: () => openDepartureDrawer(d) }, [
          el("span", { class: "up-when num", text: DOW[isoDow(d.date) - 1] + " " + d.slot }),
          dot(d.route.id),
          el("span", { class: "up-name", text: shortRoute(d.route.name) }),
          el("span", { class: "wk-pill " + d.state, text: d.booked + "/" + d.cap })
        ]));
      });
      card.appendChild(list);
    }
    holder.appendChild(card);
  }

  /* ======================================================================
     VIEW 2 — PARTICIPANTS PER HOUR
     ====================================================================== */
  function renderHours(root) {
    const routeChips = el("div", { class: "chips" });
    routeChips.appendChild(chip("All routes", !S.hours.route, dot("--none"), () => { S.hours.route = ""; S.hours.editSlot = null; renderHours(root); }, true));
    S.routes.forEach((r) => routeChips.appendChild(
      chip(shortRoute(r.name), S.hours.route === r.id, dot(r.id), () => { S.hours.route = r.id; S.hours.editSlot = null; renderHours(root); })));

    const dateI = el("input", { type: "date", value: S.hours.date });
    dateI.addEventListener("change", () => { S.hours.date = dateI.value || todayStr(); S.hours.editSlot = null; loadHours(); });

    root.appendChild(el("div", { class: "filters" }, [
      el("div", { class: "filters-row", style: "margin-bottom:12px" }, [
        el("div", { class: "filter-group", style: "flex:1" }, [el("label", { text: "Route" }), routeChips])
      ]),
      el("div", { class: "filters-row" }, [
        el("div", { class: "filter-group" }, [el("label", { text: "Date" }), dateI]),
        el("div", { class: "filter-actions" }, [
          el("button", { class: "btn btn-quiet btn-sm", text: "‹ Prev day", onclick: () => { S.hours.date = dstr(new Date(parseD(S.hours.date).getTime() - 864e5)); dateI.value = S.hours.date; loadHours(); } }),
          el("button", { class: "btn btn-quiet btn-sm", text: "Today", onclick: () => { S.hours.date = todayStr(); dateI.value = S.hours.date; loadHours(); } }),
          el("button", { class: "btn btn-quiet btn-sm", text: "Next day ›", onclick: () => { S.hours.date = dstr(new Date(parseD(S.hours.date).getTime() + 864e5)); dateI.value = S.hours.date; loadHours(); } })
        ])
      ])
    ]));
    root.appendChild(el("div", { id: "hours-holder" }));
    loadHours();
  }

  async function loadHours() {
    const holder = $("#hours-holder");
    if (!holder) return;
    clear(holder); holder.appendChild(skeletonCard());
    try {
      const qs = new URLSearchParams({ date: S.hours.date });
      if (S.hours.route) qs.set("route", S.hours.route);
      const data = await api("/admin/api/participants-per-hour?" + qs.toString());
      // When a single route is picked we also need that route's date overrides
      // so each departure can show its EFFECTIVE seats (and be edited per date).
      let overrides = [];
      if (S.hours.route) {
        try {
          const od = await api("/admin/api/date-overrides?route=" + encodeURIComponent(S.hours.route));
          overrides = od.overrides || [];
        } catch (e) { overrides = []; }
      }
      S.hours._data = { rows: data.rows || [], overrides };
      S.hours.editSlot = null;
      paintHours();
    } catch (e) {
      if (e.message !== "unauthenticated") { clear(holder); holder.appendChild(errorCard(e.message, loadHours)); }
    }
  }

  function paintHours() {
    const holder = $("#hours-holder");
    if (!holder || !S.hours._data) return;
    clear(holder);
    const route = S.hours.route ? routeById(S.hours.route) : null;
    holder.appendChild(route
      ? routeHoursCard(route, S.hours._data.rows, S.hours._data.overrides)
      : hoursCard(S.hours._data.rows));
  }

  /* ---- per-timeslot capacity: precedence helpers (mirror logic.js §7.6) ---- */
  function parsePayload(o) { try { return o && o.payload ? JSON.parse(o.payload) : null; } catch (e) { return null; } }
  function overridesForDate(list, date) {
    const out = {};
    (list || []).forEach((o) => { if (o.date === date) out[o.action] = o; });
    return out;   // keyed by action; each action is UNIQUE per (route,date)
  }
  // Resolves route.slots (POLYMORPHIC — array = same times every open day;
  // object keyed by ISO weekday "1".."7" = per-weekday times) for one date,
  // mirroring logic.js:slotsForWeekday. `date` is required to resolve the
  // object shape; pass one whenever it's available.
  function slotsRawForDate(route, date) {
    let parsed = [];
    try { parsed = JSON.parse(route.slots || "[]"); } catch (e) { parsed = []; }
    if (Array.isArray(parsed)) return parsed.slice();
    if (parsed && typeof parsed === "object") {
      const iso = date ? isoDow(date) : null;
      return (iso && parsed[String(iso)]) ? parsed[String(iso)].slice() : [];
    }
    return [];
  }
  // Effective slots for one date: route.slots (weekday-resolved), minus remove_slot, plus extra_slot.
  function dateSlots(route, ovByAction, date) {
    let slots = slotsRawForDate(route, date);
    const rem = parsePayload(ovByAction.remove_slot);
    if (rem && rem.slot) slots = slots.filter((s) => s !== rem.slot);
    const ex = parsePayload(ovByAction.extra_slot);
    if (ex && ex.slot && slots.indexOf(ex.slot) < 0) slots.push(ex.slot);
    return slots.sort();
  }
  // Four-level precedence: date+slot > date-wide > route per-slot > route default.
  function slotCapInfo(route, ovByAction, slot) {
    const sc = parsePayload(ovByAction.slot_capacity_override) || {};
    const cw = parsePayload(ovByAction.capacity_override);
    let routeSlots = {};
    try { routeSlots = JSON.parse(route.slot_capacity || "{}") || {}; } catch (e) { routeSlots = {}; }
    const hasRouteSlot = routeSlots[slot] != null;
    const routeDefault = hasRouteSlot ? routeSlots[slot] : route.capacity;
    const dateSlot = (sc[slot] != null) ? sc[slot] : null;
    const dateWide = (cw && cw.capacity != null) ? cw.capacity : null;
    let effective, source;
    if (dateSlot != null) { effective = dateSlot; source = "date_slot"; }
    else if (dateWide != null) { effective = dateWide; source = "date_wide"; }
    else if (hasRouteSlot) { effective = routeDefault; source = "route_slot"; }
    else { effective = route.capacity; source = "route"; }
    return { effective, routeDefault, dateSlot, dateWide, source };
  }
  // Save one date+slot capacity. value = integer seats, or null to clear the
  // date+slot override for this slot. The override payload is a whole map for
  // (route,date), so we merge into the existing map (INSERT OR REPLACE), and
  // delete the row entirely when the last entry is removed.
  async function saveSlotCap(route, date, slot, value, overridesList) {
    const ovByAction = overridesForDate(overridesList, date);
    const existing = ovByAction.slot_capacity_override;
    const map = parsePayload(existing) || {};
    if (value == null) delete map[slot]; else map[slot] = value;
    if (Object.keys(map).length === 0) {
      if (existing) await api("/admin/api/date-overrides/" + existing.id, { method: "DELETE" });
    } else {
      await api("/admin/api/date-overrides", {
        method: "POST",
        body: { route_id: route.id, date, action: "slot_capacity_override", payload: JSON.stringify(map) }
      });
    }
  }

  function routeHoursCard(route, rows, overrides) {
    const ovByAction = overridesForDate(overrides, S.hours.date);
    const card = el("div", { class: "card" });
    const totalGuests = rows.reduce((a, r) => a + r.guests, 0);
    card.appendChild(el("div", { class: "card-head" }, [
      el("h2", { text: prettyDate(S.hours.date) + " — " + shortRoute(route.name) }),
      el("div", { class: "grow" }),
      el("span", { class: "count-badge", text: totalGuests + " guest" + (totalGuests === 1 ? "" : "s") })
    ]));

    if (ovByAction.closed) {
      card.appendChild(el("div", { class: "empty" }, [
        el("div", { class: "big", text: "🚫" }),
        el("div", { text: "This date is closed for " + shortRoute(route.name) + ". Reopen it in Route manager → Date overrides." })
      ]));
      return card;
    }
    const slots = dateSlots(route, ovByAction, S.hours.date);
    if (slots.length === 0) {
      card.appendChild(el("div", { class: "empty" }, [
        el("div", { class: "big", text: "🗓" }),
        el("div", { text: "No start times set for this route on this date." })
      ]));
      return card;
    }

    const guestsBySlot = {}, bookingsBySlot = {};
    rows.forEach((r) => {
      guestsBySlot[r.slot] = (guestsBySlot[r.slot] || 0) + r.guests;
      bookingsBySlot[r.slot] = (bookingsBySlot[r.slot] || 0) + (r.bookings || 0);
    });

    const list = el("div", { class: "cap-list" });
    slots.forEach((slot) => {
      const info = slotCapInfo(route, ovByAction, slot);
      const cap = info.effective;
      const guests = guestsBySlot[slot] || 0;
      const left = Math.max(0, cap - guests);
      const pct = cap > 0 ? Math.min(100, Math.round((guests / cap) * 100)) : 100;
      const fillClass = cap === 0 || pct >= 100 ? "full" : pct >= 70 ? "mid" : "low";

      const badges = el("div", { class: "cap-badges" });
      if (cap === 0) badges.appendChild(el("span", { class: "cap-tag closed", text: "Closed" }));
      else if (info.source === "date_slot") badges.appendChild(el("span", { class: "cap-tag override", text: "Override" }));
      else if (info.source === "date_wide") badges.appendChild(el("span", { class: "cap-tag datecap", text: "Date cap" }));
      else if (info.source === "route_slot") badges.appendChild(el("span", { class: "cap-tag routedef", text: "Route default " + info.routeDefault }));

      const meter = el("div", { class: "cap-meter" },
        el("div", { class: "cap-fill " + fillClass, style: "width:" + (cap === 0 ? 100 : pct) + "%" }));
      const labels = el("div", { class: "cap-labels" }, [
        el("span", { class: "cap-count", text: guests + " / " + cap + " seats" }),
        el("span", { class: "cap-left", text: cap === 0 ? "closed for this date" : left + " left" })
      ]);
      const editing = S.hours.editSlot === slot;
      const row = el("button", {
        type: "button", class: "cap-row" + (cap === 0 ? " closed" : ""),
        "aria-expanded": editing ? "true" : "false",
        onclick: () => { S.hours.editSlot = editing ? null : slot; paintHours(); }
      }, [
        el("div", { class: "cap-time", text: slot }),
        el("div", { class: "cap-meter-wrap" }, [meter, labels]),
        el("div", { class: "cap-right" }, [badges, el("span", { class: "cap-edit-hint", "aria-hidden": "true", text: editing ? "▾" : "✏️" })])
      ]);
      list.appendChild(row);
      if (editing) list.appendChild(slotEditor(route, slot, info, overrides));
    });
    card.appendChild(list);
    card.appendChild(el("div", { class: "capacity-hint", style: "padding:6px 18px 16px",
      text: "Tap a start time to change its seats or close it for " + prettyDate(S.hours.date) + " only — the route’s normal seats stay as they are." }));
    return card;
  }

  function slotEditor(route, slot, info, overrides) {
    const capI = el("input", { type: "number", min: "0", step: "1", value: String(info.effective) });
    async function persist(value) {
      try {
        await saveSlotCap(route, S.hours.date, slot, value, overrides);
        toast(value == null ? slot + " reset to route default (" + info.routeDefault + ")"
          : value === 0 ? slot + " closed for " + S.hours.date
          : slot + " set to " + value + " seat" + (value === 1 ? "" : "s") + " for " + S.hours.date, "ok");
        loadHours();
      } catch (e) { toast(e.message, "err"); }
    }
    const wrap = el("div", { class: "cap-editor" }, [
      el("label", { class: "cap-editor-field" }, [el("span", { text: "Seats for " + slot }), capI]),
      el("button", { class: "btn btn-primary btn-sm", text: "Save", onclick: () => persist(Math.max(0, parseInt(capI.value, 10) || 0)) }),
      el("button", { class: "btn btn-quiet btn-sm", text: "Close departure", onclick: () => persist(0) }),
      info.dateSlot != null ? el("button", { class: "btn btn-ghost btn-sm", text: "Reset to default", onclick: () => persist(null) }) : null,
      el("button", { class: "btn btn-ghost btn-sm", text: "Cancel", onclick: () => { S.hours.editSlot = null; paintHours(); } }),
      el("p", { class: "capacity-hint",
        text: "Route default for this departure is " + info.routeDefault + " seat" + (info.routeDefault === 1 ? "" : "s") + ". Set 0 to close just this one departure (guests see “sold out”); every other slot and date is untouched." })
    ].filter(Boolean));
    return wrap;
  }

  function hoursCard(rows) {
    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "card-head" }, [
      el("h2", { text: prettyDate(S.hours.date) + " — arrivals by hour" }),
      el("div", { class: "grow" }),
      el("span", { class: "count-badge", text: rows.reduce((a, r) => a + r.guests, 0) + " guests" })
    ]));
    const body = el("div", { style: "padding:16px 18px 8px" });

    if (rows.length === 0) {
      card.appendChild(el("div", { class: "empty" }, [
        el("div", { class: "big", text: "⏰" }),
        el("div", { text: "No guests booked for this date." })
      ]));
      return card;
    }

    // group by slot -> [{route_id, route_name, guests, bookings}]
    const slots = {};
    rows.forEach((r) => { (slots[r.slot] = slots[r.slot] || []).push(r); });
    const slotKeys = Object.keys(slots).sort();
    const slotTotals = slotKeys.map((s) => slots[s].reduce((a, r) => a + r.guests, 0));
    const maxTotal = Math.max(1, ...slotTotals);

    // legend (routes present)
    const present = [];
    rows.forEach((r) => { if (!present.find((p) => p.route_id === r.route_id)) present.push(r); });
    body.appendChild(el("div", { class: "legend" }, present.map((r) =>
      el("span", { class: "legend-item" }, [el("span", { class: "sw", style: "background:var(" + (S.routeColor[r.route_id] || "--cat-3") + ")" }), shortRoute(r.route_name)]))));

    slotKeys.forEach((slot) => {
      const segs = slots[slot];
      const total = segs.reduce((a, r) => a + r.guests, 0);
      const bookings = segs.reduce((a, r) => a + (r.bookings || 0), 0);
      const track = el("div", { class: "hour-bar-track" });
      segs.forEach((seg) => {
        const w = (seg.guests / maxTotal) * 100;
        track.appendChild(el("div", {
          class: "hour-seg",
          style: "width:" + w + "%;background:var(" + (S.routeColor[seg.route_id] || "--cat-3") + ")",
          title: shortRoute(seg.route_name) + ": " + seg.guests + " guests"
        }, w > 8 ? String(seg.guests) : ""));
      });
      body.appendChild(el("div", { class: "hour-row" }, [
        el("div", { class: "hour-time", text: slot }),
        track,
        el("div", { class: "hour-count" }, [String(total), el("small", { text: bookings + " booking" + (bookings === 1 ? "" : "s") })])
      ]));
    });
    card.appendChild(body);
    card.appendChild(el("div", { class: "capacity-hint", style: "padding:4px 18px 16px", text: "Bar length is relative to the busiest hour (" + maxTotal + " guests). Each colour is a route." }));
    return card;
  }

  /* ======================================================================
     VIEW 3 — ROUTE MANAGER
     ====================================================================== */
  function renderRoutes(root) {
    clear(root);
    $("#topbar-actions").innerHTML = "";
    $("#topbar-actions").appendChild(el("button", {
      class: "btn btn-primary", text: "+ Add tour", onclick: () => openAddTour(root)
    }));

    const list = el("div", { class: "route-list", id: "route-list" });
    root.appendChild(list);
    S.routes.forEach((r) => list.appendChild(routeCard(r)));
  }

  // Classifies routes.slots (POLYMORPHIC TEXT/JSON — different-start-times-
  // per-weekday feature): an array means same times every open day; an
  // object keyed by ISO weekday string "1".."7" means per-weekday times.
  // Always returns both `arr` (used by "same" mode) and `perDay` (used by
  // "different times per day" mode) so callers don't need their own parsing.
  function parseSlotsRaw(raw) {
    let parsed;
    try { parsed = JSON.parse(raw || "[]"); } catch (e) { parsed = []; }
    if (Array.isArray(parsed)) return { mode: "same", arr: parsed, perDay: {} };
    if (parsed && typeof parsed === "object") return { mode: "perday", arr: [], perDay: parsed };
    return { mode: "same", arr: [], perDay: {} };
  }

  function routeCard(r) {
    const open = S.routesUI.openId === r.id;
    const card = el("div", { class: "route-card" + (open ? " open" : "") + (r.active ? "" : " inactive") });
    const openDays = JSON.parse(r.open_days || "[]");
    const slotsInfo = parseSlotsRaw(r.slots);
    const slotsSummary = slotsInfo.mode === "same"
      ? slotsInfo.arr.length + " slot" + (slotsInfo.arr.length === 1 ? "" : "s")
      : "different times per day";

    const head = el("div", { class: "rc-head", onclick: () => { S.routesUI.openId = open ? null : r.id; S.routesUI.tab = "details"; renderRoutes($("#view")); } }, [
      dot(r.id),
      el("div", {}, [
        el("div", { class: "rc-title", text: r.name }),
        el("div", { class: "rc-meta", text: r.city + " · " + euros(r.price_cents) + " pp · " + slotsSummary + " · " + openDays.map((d) => DOW[d - 1]).join(" ") })
      ]),
      el("div", { class: "rc-badges" }, [
        el("span", { class: "mini-badge", text: "cap " + r.capacity }),
        el("span", { class: "mini-badge", text: "max " + r.max_party }),
        el("span", { class: "mini-badge " + (r.active ? "on" : "off"), text: r.active ? "Live" : "Hidden" })
      ]),
      el("div", { class: "rc-chevron", text: "›" })
    ]);
    card.appendChild(head);

    if (open) {
      const body = el("div", { class: "rc-body" });
      const tabs = el("div", { class: "rc-tabs" }, ["details", "bars", "overrides"].map((t) =>
        el("button", { class: "rc-tab" + (S.routesUI.tab === t ? " active" : ""), text: t === "details" ? "Details" : t === "bars" ? "Bars & timing" : "Date overrides", onclick: () => { S.routesUI.tab = t; renderRoutes($("#view")); } })));
      body.appendChild(tabs);
      if (S.routesUI.tab === "details") body.appendChild(routeDetailsForm(r, openDays, slotsInfo));
      else if (S.routesUI.tab === "bars") body.appendChild(barsPanel(r));
      else body.appendChild(overridesPanel(r));
      card.appendChild(body);
    }
    return card;
  }

  function routeDetailsForm(r, openDays, slotsInfo) {
    const wrap = el("div");
    const draftDays = openDays.slice();
    // "Same times every day" draft — the original single list.
    let draftSlots = slotsInfo.mode === "same" ? slotsInfo.arr.slice() : [];
    // "Different times per day" draft — one array + one open/closed flag per
    // ISO weekday (1..7). Kept even while a day is toggled closed, so
    // reopening it restores whatever times were there before (no accidental
    // data loss from a stray click).
    const draftPerDay = {};
    const draftPerDayOpen = {};
    for (let iso = 1; iso <= 7; iso++) {
      draftPerDay[iso] = (slotsInfo.perDay[String(iso)] || []).slice();
      draftPerDayOpen[iso] = draftPerDay[iso].length > 0;
    }
    let scheduleMode = slotsInfo.mode; // "same" | "perday"
    // True only once the owner has ACTIVELY switched from "Different times
    // per day" back to "Same times every day" during THIS edit session —
    // that's the one moment weekday_capacity should actually be cleared.
    // Opening a route that already happens to be in "same" mode (e.g. it
    // uses the plain array slots shape) must NOT silently wipe an existing
    // per-weekday cap just because the owner saved an unrelated field —
    // the seats control lives in "perday" mode, so a route that's never
    // been in "perday" mode this session never had a chance to touch it.
    let weekdayCapacitySwitchedOff = false;

    // Per-slot capacity DEFAULTS for this route (independent of date) — the
    // "Rotterdam 20:00 is only ever 6 seats, every other slot stays at the
    // route's normal 10" case. Blank chip input = no override, falls back to
    // the "Seats per departure" field below. Stored as routes.slot_capacity,
    // migrations/0003. Shared across BOTH schedule modes: a departure time
    // keeps its seat override whichever weekday(s) it runs on.
    let draftSlotCapacity = {};
    try { draftSlotCapacity = JSON.parse(r.slot_capacity || "{}") || {}; } catch (e) { draftSlotCapacity = {}; }

    // Per-WEEKDAY capacity DEFAULTS (migrations/0014) — e.g. "Saturdays are
    // always 6 seats, every other open day stays at the route's normal 10",
    // as a recurring rule (not a one-off date change). Sits between the
    // per-slot override above and "Seats per departure" below. Only
    // meaningful in "Different times per day" mode — cleared when the owner
    // switches back to "Same times every day" (a per-weekday rule doesn't
    // mean anything once every day runs the same schedule).
    let draftWeekdayCapacity = {};
    try { draftWeekdayCapacity = JSON.parse(r.weekday_capacity || "{}") || {}; } catch (e) { draftWeekdayCapacity = {}; }

    // day of week toggles (used by "same times every day" mode only — the
    // "different times per day" mode has its own per-row open/closed toggle)
    const dowRow = el("div", { class: "dow-row" });
    DOW.forEach((d, i) => {
      const iso = i + 1;
      const b = el("button", { type: "button", class: "dow" + (draftDays.indexOf(iso) >= 0 ? " on" : ""), text: d, onclick: () => {
        const idx = draftDays.indexOf(iso);
        if (idx >= 0) draftDays.splice(idx, 1); else draftDays.push(iso);
        b.classList.toggle("on");
      } });
      dowRow.appendChild(b);
    });

    // Generic slot-chip editor (add/remove + per-slot "Seats per departure"
    // override) — abstracted over WHERE the times array lives so the exact
    // same widget serves both "same every day" (one shared list) and
    // "different per day" (one list per weekday row) without duplicating it.
    function makeSlotChipEditor(getSlots, setSlots) {
      const wrap2 = el("div", { class: "slot-chips" });
      function paint() {
        clear(wrap2);
        const arr = getSlots().slice().sort();
        setSlots(arr);
        arr.forEach((s) => {
          const hasOverride = draftSlotCapacity[s] != null;
          const capI = el("input", {
            type: "number", min: "0", step: "1",
            value: hasOverride ? String(draftSlotCapacity[s]) : "",
            placeholder: "default",
            title: "Seats for the " + s + " departure only — blank uses “Seats per departure” below",
            oninput: (e) => {
              const v = e.target.value.trim();
              if (v === "") delete draftSlotCapacity[s];
              else draftSlotCapacity[s] = Math.max(0, parseInt(v, 10) || 0);
            }
          });
          wrap2.appendChild(el("span", { class: "slot-chip" + (hasOverride ? " has-override" : "") }, [s, capI,
            el("button", { type: "button", "aria-label": "Remove " + s, text: "×", onclick: () => { setSlots(getSlots().filter((x) => x !== s)); paint(); } })]));
        });
        const timeIn = el("input", { type: "time", style: "width:118px" });
        const addBtn = el("button", { type: "button", class: "btn btn-quiet btn-sm", text: "+ Add", onclick: () => {
          if (timeIn.value && getSlots().indexOf(timeIn.value) < 0) { setSlots(getSlots().concat([timeIn.value])); paint(); }
        } });
        wrap2.appendChild(timeIn); wrap2.appendChild(addBtn);
      }
      paint();
      return wrap2;
    }

    // "Different times per day" — one row per weekday, each with its own
    // open/closed toggle and (when open) its own slot-chip editor.
    const perDayWrap = el("div", { style: "display:flex;flex-direction:column;gap:10px" });
    function paintPerDay() {
      clear(perDayWrap);
      DOW_FULL.forEach((label, i) => {
        const iso = i + 1;
        const row = el("div", { style: "display:flex;align-items:flex-start;gap:12px" });
        const toggleBtn = el("button", {
          type: "button", class: "dow" + (draftPerDayOpen[iso] ? " on" : ""), style: "width:52px;flex:none",
          text: DOW[i],
          title: label + (draftPerDayOpen[iso] ? " — open" : " — closed"),
          onclick: () => { draftPerDayOpen[iso] = !draftPerDayOpen[iso]; paintPerDay(); }
        });
        row.appendChild(toggleBtn);
        if (draftPerDayOpen[iso]) {
          row.appendChild(makeSlotChipEditor(
            () => draftPerDay[iso] || [],
            (v) => { draftPerDay[iso] = v; }
          ));
          // Per-weekday seat count (migrations/0014) — optional, blank uses
          // "Seats per departure" below (same fallback convention as the
          // per-slot chip override above it).
          const hasWeekdayCap = draftWeekdayCapacity[String(iso)] != null;
          row.appendChild(el("input", {
            type: "number", min: "1", step: "1",
            value: hasWeekdayCap ? String(draftWeekdayCapacity[String(iso)]) : "",
            placeholder: "seats",
            style: "width:72px;flex:none",
            title: label + " — seats per departure that day only, blank uses “Seats per departure” below",
            oninput: (e) => {
              const v = e.target.value.trim();
              if (v === "") delete draftWeekdayCapacity[String(iso)];
              else draftWeekdayCapacity[String(iso)] = Math.max(1, parseInt(v, 10) || 1);
            }
          }));
        } else {
          row.appendChild(el("span", { class: "capacity-hint", style: "padding:8px 0 0", text: "Closed" }));
        }
        perDayWrap.appendChild(row);
      });
    }

    // Mode toggle ("Same times every day" vs "Different times per day") +
    // whichever editor is currently active — rebuilt on every mode switch,
    // same pattern as the other paintX() functions in this file.
    const scheduleWrap = el("div", { class: "field wide" });
    function paintScheduleSection() {
      clear(scheduleWrap);
      scheduleWrap.appendChild(el("label", { text: "Start times" }));
      const seg = el("div", { class: "seg", style: "margin:2px 0 10px" }, [
        segBtn("Same times every day", scheduleMode === "same", () => {
          if (scheduleMode === "same") return;
          // Carry data forward: union of every weekday's times so far
          // (deduped, sorted) — switching modes never silently drops times
          // the owner already typed in.
          const union = new Set();
          for (let iso = 1; iso <= 7; iso++) (draftPerDay[iso] || []).forEach((s) => union.add(s));
          if (union.size > 0) draftSlots = Array.from(union).sort();
          // A per-weekday seat count only means something when different
          // weekdays can differ at all — clear it going back to "same".
          // This is a deliberate action this session, so (unlike simply
          // opening an already-"same" route) it's fine to actually persist
          // the clear on Save.
          draftWeekdayCapacity = {};
          weekdayCapacitySwitchedOff = true;
          scheduleMode = "same";
          paintScheduleSection();
        }),
        segBtn("Different times per day", scheduleMode === "perday", () => {
          if (scheduleMode === "perday") return;
          // Carry data forward: every currently-open weekday starts out
          // pre-filled with the same-mode times, so the owner is adjusting
          // an existing schedule rather than starting from a blank slate.
          draftDays.forEach((iso) => {
            if (!draftPerDay[iso] || draftPerDay[iso].length === 0) draftPerDay[iso] = draftSlots.slice();
            draftPerDayOpen[iso] = true;
          });
          scheduleMode = "perday";
          paintScheduleSection();
        })
      ]);
      scheduleWrap.appendChild(seg);
      if (scheduleMode === "same") {
        scheduleWrap.appendChild(el("div", { class: "capacity-hint", style: "padding:0 0 8px", text: "Open days" }));
        scheduleWrap.appendChild(dowRow);
        scheduleWrap.appendChild(makeSlotChipEditor(() => draftSlots, (v) => { draftSlots = v; }));
      } else {
        paintPerDay();
        scheduleWrap.appendChild(perDayWrap);
      }
      scheduleWrap.appendChild(el("p", { class: "capacity-hint", text: "Type a number on a time chip to give just that departure its own seat count (e.g. a bar that's busier at 20:00) — leave blank to use “Seats per departure” above." }));
    }
    paintScheduleSection();

    const priceIn = el("input", { type: "number", min: "0", step: "0.5", value: (r.price_cents / 100).toFixed(2) });
    const capIn = el("input", { type: "number", min: "1", value: r.capacity });
    const maxIn = el("input", { type: "number", min: "1", max: "12", value: r.max_party });
    const cityIn = el("input", { type: "text", value: r.city });
    const nameIn = el("input", { type: "text", value: r.name });
    const mapIn = el("input", { type: "text", value: r.map_url || "", placeholder: "https:// English route map (PDF)" });
    const mapNlIn = el("input", { type: "text", value: r.map_url_nl || "", placeholder: "https:// Dutch route map (PDF)" });
    const currencyIn = currencySelect(r.currency);
    const timezoneIn = timezoneSelect(r.timezone);
    const activeIn = el("input", { type: "checkbox" }); activeIn.checked = !!r.active;

    wrap.appendChild(el("div", { class: "form-grid" }, [
      field("Display name", nameIn, "wide"),
      field("City", cityIn),
      field("Price per person", priceIn),
      field("Currency", currencyIn),
      field("Seats per departure", capIn),
      field("Max guests per booking", maxIn),
      field("Timezone (bar arrival times + booking calendar)", timezoneIn, "wide"),
      scheduleWrap,
      field("Route map link — English (shown inside the confirmation email)", mapIn, "wide"),
      field("Route map link — Dutch (sent to guests who booked in Dutch; leave blank to use the English map)", mapNlIn, "wide")
    ]));

    wrap.appendChild(el("div", { class: "rc-actions" }, [
      el("label", { class: "switch" }, [activeIn, el("span", { class: "track" }), "Bookable (live)"]),
      el("div", { class: "grow" }),
      el("button", {
        class: "btn btn-primary", text: "Save changes", onclick: async (ev) => {
          const btn = ev.currentTarget; btn.disabled = true;
          try {
            // Same-every-day mode sends the original array shape + whatever
            // open_days the day-toggle row says. Per-day mode sends the
            // object shape and DERIVES open_days from it here too (matching
            // what the server also derives, so the dashboard's own display —
            // e.g. the route card's day chips — is correct even before the
            // next reload).
            let slotsPayload, openDaysPayload;
            if (scheduleMode === "same") {
              slotsPayload = JSON.stringify(draftSlots.slice().sort());
              openDaysPayload = JSON.stringify(draftDays.slice().sort((a, b) => a - b));
            } else {
              const obj = {};
              const openIsos = [];
              for (let iso = 1; iso <= 7; iso++) {
                if (draftPerDayOpen[iso] && (draftPerDay[iso] || []).length > 0) {
                  obj[String(iso)] = draftPerDay[iso].slice().sort();
                  openIsos.push(iso);
                } else {
                  // A seat count on a CLOSED weekday has no effect and no
                  // visible control to remove it — prune it here so it can
                  // never get "stuck" invisibly in the saved data.
                  delete draftWeekdayCapacity[String(iso)];
                }
              }
              slotsPayload = JSON.stringify(obj);
              openDaysPayload = JSON.stringify(openIsos);
            }
            const patch = {
              name: nameIn.value.trim(), city: cityIn.value.trim(),
              price_cents: Math.round(parseFloat(priceIn.value) * 100) || r.price_cents,
              capacity: parseInt(capIn.value, 10) || r.capacity,
              max_party: parseInt(maxIn.value, 10) || r.max_party,
              open_days: openDaysPayload,
              slots: slotsPayload,
              slot_capacity: JSON.stringify(draftSlotCapacity),
              map_url: mapIn.value.trim() || null,
              map_url_nl: mapNlIn.value.trim() || null,
              active: activeIn.checked ? 1 : 0,
              currency: currencyIn.value,
              timezone: timezoneIn.value
            };
            // Per-weekday seat count only has an editor in "Different times
            // per day" mode. Only include the field at all when there's
            // something for THIS session to actually say about it — either
            // the owner is currently editing per-day drafts, or just
            // deliberately switched off per-day mode (which clears it).
            // Otherwise the key is omitted so an unrelated save (e.g. just
            // the price) never touches an existing per-weekday cap the
            // owner never saw a control for.
            if (scheduleMode === "perday" || weekdayCapacitySwitchedOff) {
              patch.weekday_capacity = JSON.stringify(scheduleMode === "perday" ? draftWeekdayCapacity : {});
            }
            await api("/admin/api/routes/" + r.id, { method: "PUT", body: patch });
            Object.assign(r, patch);
            toast("Saved ‘" + r.name + "’", "ok");
            renderRoutes($("#view"));
          } catch (e) { toast(e.message, "err"); btn.disabled = false; }
        }
      })
    ]));
    return wrap;
  }

  // Per-weekday bar sets (migrations/0015): a route can run a DIFFERENT,
  // RECURRING ordered bar list on different weekdays (Thursday's stops vs
  // Friday's), distinct from the existing one-off per-date "Alt bars"
  // date override. Mirrors the "Same/Different times per day" UX from the
  // Details tab: a mode toggle, and in "different" mode a weekday selector
  // reveals that weekday's own ordered list — reusing the exact same
  // bar-row editor either way. The DEFAULT (no-weekday) set is what a route
  // that's never touched this feature has always had; nothing about it
  // changes when the owner stays in "Same bars every day".
  //
  // Drafts are cached in S.routesUI.bars keyed "<routeId>|default" or
  // "<routeId>|wd<1-7>" — one GET (handleListBars, ALL rows) populates every
  // key at once, grouped client-side by each row's `weekday`.
  function barsStateKey(routeId, mode, weekday) {
    return routeId + "|" + (mode === "perday" ? "wd" + weekday : "default");
  }

  function barsPanel(r) {
    const wrap = el("div");
    wrap.appendChild(el("p", { class: "capacity-hint", text: "Each bar gets its own arrival email, staggered by the minutes after the booked start time." }));

    S.routesUI.barsMode = S.routesUI.barsMode || {};
    S.routesUI.barsWeekday = S.routesUI.barsWeekday || {};
    S.routesUI.barsAllLoaded = S.routesUI.barsAllLoaded || {};
    if (!(r.id in S.routesUI.barsMode)) S.routesUI.barsMode[r.id] = "same";
    if (!(r.id in S.routesUI.barsWeekday)) S.routesUI.barsWeekday[r.id] = 1;
    const mode = S.routesUI.barsMode[r.id];
    const weekday = S.routesUI.barsWeekday[r.id];
    const stateKey = barsStateKey(r.id, mode, weekday);

    const modeWrap = el("div", { class: "field wide" });
    modeWrap.appendChild(el("label", { text: "Bars" }));
    modeWrap.appendChild(el("div", { class: "seg", style: "margin:2px 0 10px" }, [
      segBtn("Same bars every day", mode === "same", () => { S.routesUI.barsMode[r.id] = "same"; renderRoutes($("#view")); }),
      segBtn("Different bars per day", mode === "perday", () => { S.routesUI.barsMode[r.id] = "perday"; renderRoutes($("#view")); })
    ]));
    wrap.appendChild(modeWrap);

    if (mode === "perday") {
      const wdRow = el("div", { class: "dow-row" });
      DOW.forEach((d, i) => {
        const iso = i + 1;
        wdRow.appendChild(el("button", {
          type: "button", class: "dow" + (weekday === iso ? " on" : ""), text: d,
          onclick: () => { S.routesUI.barsWeekday[r.id] = iso; renderRoutes($("#view")); }
        }));
      });
      wrap.appendChild(wdRow);
      wrap.appendChild(el("p", { class: "capacity-hint", style: "margin:6px 0 0", text: "Editing " + DOW_FULL[weekday - 1] + "'s bars. Any weekday you never save here keeps using the default (\"Same bars every day\") list below." }));
    }

    const listEl = el("div", { class: "bar-list", id: "bars-" + r.id });
    wrap.appendChild(listEl);

    // paint() always reads the live draft from state, so it works whether the
    // bars were already cached or arrive later from an async fetch.
    function paint() {
      const draft = S.routesUI.bars[stateKey] || [];
      clear(listEl);
      if (draft.length === 0) { listEl.appendChild(el("p", { class: "capacity-hint", text: "No bars yet. Add the stops for this route below." })); return; }
      draft.forEach((bar, i) => {
        const nameI = el("input", { type: "text", value: bar.bar_name, placeholder: "Bar name", oninput: (e) => bar.bar_name = e.target.value });
        const mailI = el("input", { type: "email", value: bar.bar_email, placeholder: "email@bar.nl", oninput: (e) => bar.bar_email = e.target.value });
        const offI = el("input", { type: "number", min: "0", step: "5", value: bar.minutes_offset, style: "width:64px", oninput: (e) => bar.minutes_offset = parseInt(e.target.value, 10) || 0 });
        listEl.appendChild(el("div", { class: "bar-item" }, [
          el("div", { class: "bar-ord", text: i + 1 }),
          nameI, mailI,
          el("div", { class: "bar-offset" }, [offI, el("span", { text: "min" })]),
          el("button", { class: "icon-btn", "aria-label": "Remove bar", text: "×", onclick: () => { S.routesUI.bars[stateKey].splice(i, 1); paint(); } })
        ]));
      });
    }
    if (S.routesUI.bars[stateKey]) paint();
    else if (S.routesUI.barsAllLoaded[r.id]) { S.routesUI.bars[stateKey] = []; paint(); }
    else { listEl.appendChild(skeletonRows(3)); loadBars(r); }

    wrap.appendChild(el("div", { class: "rc-actions" }, [
      el("button", { class: "btn btn-quiet", text: "+ Add bar", onclick: () => { (S.routesUI.bars[stateKey] = S.routesUI.bars[stateKey] || []).push({ bar_name: "", bar_email: "bookings@wogoamsterdam.com", minutes_offset: (S.routesUI.bars[stateKey].length) * 75 }); paint(); } }),
      el("div", { class: "grow" }),
      el("button", {
        class: "btn btn-primary", text: mode === "perday" ? "Save " + DOW_FULL[weekday - 1] + "'s bars" : "Save bars", onclick: async (ev) => {
          const btn = ev.currentTarget; btn.disabled = true;
          try {
            const bars = (S.routesUI.bars[stateKey] || []).map((b, i) => ({ ord: i + 1, bar_name: b.bar_name, bar_email: b.bar_email, minutes_offset: b.minutes_offset }));
            const body = mode === "perday" ? { bars, weekday } : { bars };
            await api("/admin/api/routes/" + r.id + "/bars", { method: "PUT", body });
            toast("Bar list saved", "ok");
          } catch (e) { toast(e.message, "err"); }
          btn.disabled = false;
        }
      })
    ]));
    return wrap;
  }
  async function loadBars(r) {
    try {
      const d = await api("/admin/api/routes/" + r.id + "/bars");
      const byKey = {};
      (d.bars || []).slice().sort((a, b) => a.ord - b.ord).forEach((b) => {
        const key = r.id + "|" + (b.weekday == null ? "default" : "wd" + b.weekday);
        (byKey[key] = byKey[key] || []).push({ bar_name: b.bar_name, bar_email: b.bar_email, minutes_offset: b.minutes_offset });
      });
      Object.keys(byKey).forEach((key) => { S.routesUI.bars[key] = byKey[key]; });
      if (!S.routesUI.bars[r.id + "|default"]) S.routesUI.bars[r.id + "|default"] = [];
      S.routesUI.barsAllLoaded[r.id] = true;
      if (S.routesUI.openId === r.id && S.routesUI.tab === "bars") renderRoutes($("#view"));
    }
    catch (e) { /* noop */ }
  }

  function overridesPanel(r) {
    const wrap = el("div");
    const listEl = el("div", { class: "ov-list", id: "ov-" + r.id });
    wrap.appendChild(listEl);

    function paint(list) {
      clear(listEl);
      if (!list || list.length === 0) { listEl.appendChild(el("p", { class: "capacity-hint", text: "No date changes yet. Close a date, cap seats, or add a one-off slot below." })); return; }
      list.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((o) => {
        listEl.appendChild(el("div", { class: "ov-item" }, [
          el("span", { class: "ov-date", text: o.date }),
          el("span", { class: "ov-action " + (o.action === "closed" ? "closed" : ""), text: prettyAction(o.action) }),
          el("span", { class: "ov-payload", text: o.payload ? summarizePayload(o.action, o.payload) : "" }),
          el("div", { class: "grow" }),
          el("button", { class: "btn btn-danger btn-sm", text: "Remove", onclick: async () => {
            try { await api("/admin/api/date-overrides/" + o.id, { method: "DELETE" }); toast("Override removed", "ok"); loadOverrides(r, paint); }
            catch (e) { toast(e.message, "err"); } } })
        ]));
      });
    }
    loadOverrides(r, paint);
    listEl.appendChild(skeletonRows(2));

    // add form
    const dateI = el("input", { type: "date" });
    const actionOpts = ["closed", "capacity_override", "slot_capacity_override", "remove_slot", "extra_slot", "alternate_bars"];
    const actionI = el("select", {}, actionOpts.map((a) => el("option", { value: a, text: prettyAction(a) })));
    const payloadI = el("input", { type: "text", placeholder: "e.g. 6  (seats)  or  21:00", style: "width:190px" });
    const payloadWrap = el("div", { class: "field" }, [el("label", { text: "Value" }), payloadI]);
    const payloadHint = el("p", { class: "capacity-hint", style: "flex-basis:100%;margin:0" });
    function syncPayloadVisibility() {
      const a = actionI.value;
      payloadWrap.style.display = a === "closed" ? "none" : "flex";
      payloadI.placeholder =
        a === "capacity_override" ? "seats, e.g. 6" :
        a === "slot_capacity_override" ? "20:00=4, 19:00=6" :
        a === "remove_slot" ? "slot, e.g. 18:00" :
        a === "extra_slot" ? "slot, e.g. 21:00" : "bar name";
      payloadHint.textContent = a === "slot_capacity_override"
        ? "One or more slot=seats pairs, comma-separated. 0 means that slot shows 0 seats left (closed) that date. This REPLACES the whole list for this date — include every slot you want capped, not just the new one."
        : "";
    }
    actionI.addEventListener("change", syncPayloadVisibility);
    syncPayloadVisibility();

    wrap.appendChild(el("div", { class: "subhead", text: "Add a date change" }));
    wrap.appendChild(el("div", { class: "inline-form" }, [
      el("div", { class: "field" }, [el("label", { text: "Date" }), dateI]),
      el("div", { class: "field" }, [el("label", { text: "Change" }), actionI]),
      payloadWrap,
      el("button", { class: "btn btn-primary btn-sm", text: "Apply", onclick: async () => {
        if (!dateI.value) { toast("Pick a date first", "err"); return; }
        const payload = buildPayload(actionI.value, payloadI.value.trim());
        if (payload === undefined) { toast("Enter at least one slot=seats pair, e.g. 20:00=4", "err"); return; }
        try {
          await api("/admin/api/date-overrides", { method: "POST", body: { route_id: r.id, date: dateI.value, action: actionI.value, payload } });
          toast("Date change applied", "ok"); payloadI.value = ""; loadOverrides(r, paint);
        } catch (e) { toast(e.message, "err"); }
      } }),
      payloadHint
    ]));
    return wrap;
  }
  async function loadOverrides(r, paint) {
    try { const d = await api("/admin/api/date-overrides?route=" + encodeURIComponent(r.id)); paint(d.overrides || []); }
    catch (e) { paint([]); }
  }
  function buildPayload(action, val) {
    if (action === "closed") return null;
    if (action === "capacity_override") return JSON.stringify({ capacity: parseInt(val, 10) || 0 });
    if (action === "slot_capacity_override") {
      const map = {};
      val.split(",").map((s) => s.trim()).filter(Boolean).forEach((pair) => {
        const [slot, cap] = pair.split("=").map((x) => x.trim());
        if (slot && cap !== undefined && cap !== "") map[slot] = Math.max(0, parseInt(cap, 10) || 0);
      });
      if (Object.keys(map).length === 0) return undefined; // signals "nothing entered" to the caller
      return JSON.stringify(map);
    }
    if (action === "remove_slot") return JSON.stringify({ slot: val });
    if (action === "extra_slot") return JSON.stringify({ slot: val });
    if (action === "alternate_bars") return JSON.stringify([{ bar_name: val, bar_email: "bookings@wogoamsterdam.com", minutes_offset: 0 }]);
    return null;
  }
  function summarizePayload(action, payload) {
    try {
      const p = JSON.parse(payload);
      if (action === "capacity_override") return p.capacity + " seats";
      if (action === "slot_capacity_override") return Object.keys(p).map((k) => k + "→" + p[k]).join(", ");
      if (action === "remove_slot" || action === "extra_slot") return p.slot;
      if (action === "alternate_bars") return (Array.isArray(p) ? p.length : 0) + " alt bar(s)";
    } catch (e) { /* noop */ }
    return "";
  }
  function prettyAction(a) {
    return {
      closed: "Closed", capacity_override: "Cap all slots", slot_capacity_override: "Cap one slot",
      remove_slot: "Remove slot", extra_slot: "Extra slot", alternate_bars: "Alt bars"
    }[a] || a;
  }

  function openAddTour(root) {
    const idI = el("input", { type: "text", placeholder: "e.g. haarlem" });
    const nameI = el("input", { type: "text", placeholder: "WOGO Cocktail Walk Haarlem" });
    const cityI = el("input", { type: "text", placeholder: "Haarlem" });
    const priceI = el("input", { type: "number", value: "29.95", step: "0.5" });
    const capI = el("input", { type: "number", value: "10" });
    const maxI = el("input", { type: "number", value: "6" });
    const currencyI = currencySelect("EUR");
    const timezoneI = timezoneSelect("Europe/Amsterdam");
    const draftDays = [4, 5, 6];
    const dowRow = el("div", { class: "dow-row" });
    DOW.forEach((d, i) => { const iso = i + 1; const b = el("button", { type: "button", class: "dow" + (draftDays.indexOf(iso) >= 0 ? " on" : ""), text: d, onclick: () => { const x = draftDays.indexOf(iso); if (x >= 0) draftDays.splice(x, 1); else draftDays.push(iso); b.classList.toggle("on"); } }); dowRow.appendChild(b); });
    const slotsI = el("input", { type: "text", value: "17:30, 18:00, 18:30", placeholder: "comma-separated HH:MM" });
    const mapI = el("input", { type: "text", placeholder: "https://www.wogococktailwalk.com/maps/haarlem-en.pdf" });
    const mapNlI = el("input", { type: "text", placeholder: "https://www.wogococktailwalk.com/maps/haarlem-nl.pdf" });

    const card = el("div", { class: "card", style: "margin-bottom:16px" });
    card.appendChild(el("div", { class: "card-head" }, [el("h2", { text: "Add a new tour" }), el("div", { class: "grow" }), el("button", { class: "icon-btn", "aria-label": "Cancel", text: "✕", onclick: () => renderRoutes(root) })]));
    const body = el("div", { style: "padding:18px" });
    body.appendChild(el("div", { class: "form-grid" }, [
      field("Slug (url id, lowercase)", idI),
      field("Display name", nameI),
      field("City", cityI),
      field("Price per person", priceI),
      field("Currency", currencyI),
      field("Seats per departure", capI),
      field("Max per booking", maxI),
      field("Timezone (bar arrival times + booking calendar)", timezoneI, "wide"),
      el("div", { class: "field wide" }, [el("label", { text: "Open days" }), dowRow]),
      field("Start times", slotsI, "wide"),
      field("Route map link — English (shown inside the confirmation email)", mapI, "wide"),
      field("Route map link — Dutch (sent to guests who booked in Dutch; leave blank to use the English map)", mapNlI, "wide")
    ]));
    body.appendChild(el("div", { class: "rc-actions" }, [
      el("div", { class: "grow" }),
      el("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => renderRoutes(root) }),
      el("button", {
        class: "btn btn-primary", text: "Create tour", onclick: async (ev) => {
          const btn = ev.currentTarget;
          const id = idI.value.trim().toLowerCase();
          if (!/^[a-z0-9-]+$/.test(id)) { toast("Slug must be lowercase letters, numbers, dashes", "err"); return; }
          if (S.routes.find((r) => r.id === id)) { toast("That slug already exists", "err"); return; }
          btn.disabled = true;
          const slots = slotsI.value.split(",").map((s) => s.trim()).filter(Boolean);
          const route = {
            id, name: nameI.value.trim() || ("WOGO Cocktail Walk " + cityI.value.trim()),
            city: cityI.value.trim(), price_cents: Math.round(parseFloat(priceI.value) * 100) || 2995,
            capacity: parseInt(capI.value, 10) || 10, max_party: parseInt(maxI.value, 10) || 6,
            open_days: JSON.stringify(draftDays.sort((a, b) => a - b)), slots: JSON.stringify(slots),
            currency: currencyI.value, timezone: timezoneI.value,
            map_url: mapI.value.trim() || null, map_url_nl: mapNlI.value.trim() || null, active: 1
          };
          try {
            await api("/admin/api/routes", { method: "POST", body: route });
            route.created_at = todayStr();
            S.routes.push(route); assignColors();
            toast("Created ‘" + route.name + "’", "ok");
            S.routesUI.openId = id; S.routesUI.tab = "details";
            renderRoutes(root);
          } catch (e) { toast(e.message, "err"); btn.disabled = false; }
        }
      })
    ]));
    card.appendChild(body);
    clear(root); root.appendChild(card);
    const list = el("div", { class: "route-list" });
    root.appendChild(list);
    S.routes.forEach((r) => list.appendChild(routeCard(r)));
  }

  /* ======================================================================
     VIEW 4 — EXPORT
     ====================================================================== */
  function renderExport(root) {
    const f = {};
    const routeSel = selectField("Route", "", ["All routes"].concat(S.routes.map((r) => r.name)), (v) => {
      if (v === "All routes") delete f.route; else { const r = S.routes.find((x) => x.name === v); f.route = r ? r.id : undefined; }
    }, "All routes");
    const citySel = selectField("City", "", ["All cities"].concat(cities()), (v) => { if (v === "All cities") delete f.city; else f.city = v; }, "All cities");
    const statusSel = selectField("Status", "", ["All statuses"].concat(STATUSES.map(prettyStatus)), (v) => {
      if (v === "All statuses") delete f.status; else f.status = STATUSES[["All statuses"].concat(STATUSES.map(prettyStatus)).indexOf(v) - 1];
    }, "All statuses");
    const fromF = dateField("From", "", (v) => { if (v) f.date_from = v; else delete f.date_from; });
    const toF = dateField("To", "", (v) => { if (v) f.date_to = v; else delete f.date_to; });

    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "card-head" }, [el("h2", { text: "Download bookings (CSV)" })]));
    const body = el("div", { style: "padding:18px" });
    body.appendChild(el("p", { class: "capacity-hint", text: "Choose what to include, then download. Opens in Excel, Numbers or Google Sheets." }));
    body.appendChild(el("div", { class: "filters-row", style: "margin-bottom:20px" }, [routeSel, citySel, statusSel, fromF, toF]));
    body.appendChild(el("button", {
      class: "btn btn-primary", text: "⬇  Download CSV", onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        const qs = new URLSearchParams();
        for (const k in f) if (f[k]) qs.set(k, f[k]);
        try {
          const res = await fetch(API + "/admin/api/bookings.csv?" + qs.toString(), { credentials: "same-origin" });
          if (res.status === 401) { showLogin(); return; }
          if (!res.ok) throw new Error("Export failed (" + res.status + ")");
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = el("a", { href: url, download: "wogo-bookings-" + todayStr() + ".csv" });
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          toast("Downloaded CSV", "ok");
        } catch (e) { toast(e.message, "err"); }
        btn.disabled = false;
      }
    }));
    card.appendChild(body);
    root.appendChild(card);
  }

  /* ======================================================================
     VIEW — GIFT CARDS (migrations/0018/0019)
     Read-only list (code, initial/balance, status, recipient, created) plus
     a "Void" action for an active card (e.g. a refunded purchase). Balances
     themselves only ever move via a Stripe-webhook-triggered redemption —
     nothing here edits balance_cents directly.
     ====================================================================== */

  // Reuses the existing booking-status badge palette (admin.css) rather than
  // inventing new colors: active reads as "good" (confirmed's green), void
  // as "gone" (cancelled's red), depleted as neutral (hold's amber) — a
  // fully-spent card isn't a problem, just informational.
  function giftStatusTag(status) {
    const cls = status === "active" ? "confirmed" : status === "void" ? "cancelled" : "hold";
    const label = { active: "Active", depleted: "Depleted", void: "Void" }[status] || status;
    return el("span", { class: "badge " + cls, text: label });
  }

  function renderGiftCards(root) {
    clear(root);
    root.appendChild(el("div", { class: "stat-row", id: "gc-stats" }));
    root.appendChild(el("div", { id: "gc-holder" }));
    if (S.giftCards.loaded) paintGiftCards();
    else loadGiftCards();
  }

  async function loadGiftCards() {
    const holder = $("#gc-holder");
    if (!holder) return;
    clear(holder);
    holder.appendChild(skeletonCard());
    try {
      const data = await api("/admin/api/gift-cards");
      S.giftCards.list = data.gift_cards || [];
      S.giftCards.loaded = true;
      paintGiftCards();
    } catch (e) {
      if (e.message !== "unauthenticated") { clear(holder); holder.appendChild(errorCard(e.message, loadGiftCards)); }
    }
  }

  function paintGiftCards() {
    const stats = $("#gc-stats"), holder = $("#gc-holder");
    if (!holder) return;
    const list = S.giftCards.list;

    if (stats) {
      clear(stats);
      const active = list.filter((c) => c.status === "active");
      const outstanding = active.reduce((a, c) => a + c.balance_cents, 0);
      const sold = list.reduce((a, c) => a + c.initial_cents, 0);
      stats.appendChild(stat("Cards sold", list.length, "all time"));
      stats.appendChild(stat("Active balance", euros(outstanding), active.length + " active card" + (active.length === 1 ? "" : "s")));
      stats.appendChild(stat("Total sold", euros(sold), "face value, all cards"));
    }

    clear(holder);
    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "card-head" }, [
      el("h2", { text: "Gift cards" }),
      el("span", { class: "count-badge", text: list.length + (list.length === 1 ? " card" : " cards") })
    ]));
    if (list.length === 0) {
      card.appendChild(el("div", { class: "empty" }, [
        el("div", { class: "big", text: "🎁" }),
        el("div", { text: "No gift cards sold yet — they appear here the moment someone buys one." })
      ]));
      holder.appendChild(card);
      return;
    }
    const scroll = el("div", { class: "table-scroll" });
    const t = el("table", { class: "data" });
    t.appendChild(el("thead", {}, el("tr", {}, [
      th("Code"), th("Initial"), th("Balance"), th("Status"), th("Recipient"), th("Buyer"), th("Created"), th("")
    ])));
    const tb = el("tbody");
    list.forEach((c) => {
      const voidBtn = el("button", {
        class: "btn btn-quiet btn-sm", text: "Void",
        disabled: c.status !== "active",
        onclick: async (ev) => {
          ev.stopPropagation();
          if (!confirm("Void gift card " + c.code + "? This cannot be undone.")) return;
          try {
            await api("/admin/api/gift-cards/" + encodeURIComponent(c.code) + "/void", { method: "POST" });
            toast("Gift card voided", "ok");
            S.giftCards.loaded = false;
            loadGiftCards();
          } catch (e) { if (e.message !== "unauthenticated") toast(e.message, "err"); }
        }
      });
      tb.appendChild(el("tr", {}, [
        el("td", { class: "td-name", style: "font-family:ui-monospace,Menlo,monospace;font-size:12.5px", text: c.code }),
        el("td", { class: "num", text: euros(c.initial_cents) }),
        el("td", { class: "num td-name", text: euros(c.balance_cents) }),
        el("td", {}, giftStatusTag(c.status)),
        el("td", {}, [el("div", { class: "td-name", text: c.recipient_name || "—" }), el("div", { class: "td-sub", text: c.recipient_email || "" })]),
        el("td", {}, [el("div", { class: "td-name", text: c.buyer_name || "—" }), el("div", { class: "td-sub", text: c.buyer_email || "" })]),
        el("td", { class: "td-sub num", text: c.created_at ? prettyDate(String(c.created_at).slice(0, 10)) : "—" }),
        el("td", {}, voidBtn)
      ]));
    });
    t.appendChild(tb);
    scroll.appendChild(t);
    card.appendChild(scroll);
    holder.appendChild(card);
  }

  /* ======================================================================
     VIEW 5 — CUSTOMERS (CRM)
     Derived from bookings by the Worker (no separate customers table).
     Search, spend, discounts; click-through detail with edit-propagation;
     "+ Manual booking" for phone bookings (same seat guard as the widget).
     ====================================================================== */
  function renderCustomers(root) {
    clear(root);
    $("#topbar-actions").innerHTML = "";
    $("#topbar-actions").appendChild(el("button", {
      class: "btn btn-primary", text: "+ Manual booking",
      onclick: () => {
        S.customers.formOpen = true;
        renderCustomers(root);
        setTimeout(() => { const i = $("#mb-name"); if (i) i.focus(); }, 60);
      }
    }));

    if (S.customers.formOpen) root.appendChild(manualBookingCard(root));

    const searchInput = el("input", { type: "text", placeholder: "Name, email or phone…", value: S.customers.q });
    let sT;
    searchInput.addEventListener("input", () => {
      clearTimeout(sT);
      sT = setTimeout(() => { S.customers.q = searchInput.value.trim(); loadCustomers(); }, 320);
    });
    root.appendChild(el("div", { class: "filters" }, [
      el("div", { class: "filters-row" }, [
        el("div", { class: "filter-group search", style: "flex:1;max-width:340px" }, [el("label", { text: "Search customers" }), searchInput])
      ])
    ]));

    root.appendChild(el("div", { class: "stat-row", id: "cust-stats" }));
    root.appendChild(el("div", { id: "cust-holder" }));

    if (S.customers.loaded) paintCustomers();
    else loadCustomers();
  }

  async function loadCustomers() {
    const holder = $("#cust-holder");
    if (!holder) return;
    clear(holder);
    holder.appendChild(skeletonCard());
    try {
      const jobs = [api("/admin/api/customers" + (S.customers.q ? "?q=" + encodeURIComponent(S.customers.q) : ""))];
      // one-time fetch of bookings, only to map email -> promo codes used
      // (the aggregate endpoint returns the amount saved but not the codes)
      if (!S.customers.codesLoaded) jobs.push(api("/admin/api/bookings?limit=10000"));
      const res = await Promise.all(jobs);
      S.customers.list = res[0].customers || [];
      if (res[1]) {
        const codes = {};
        (res[1].bookings || []).forEach((b) => {
          if (!b.discount_code) return;
          const k = String(b.email || "").trim().toLowerCase();
          const arr = (codes[k] = codes[k] || []);
          if (arr.indexOf(b.discount_code) < 0) arr.push(b.discount_code);
        });
        S.customers.codes = codes;
        S.customers.codesLoaded = true;
      }
      S.customers.loaded = true;
      paintCustomers();
    } catch (e) {
      if (e.message !== "unauthenticated") { clear(holder); holder.appendChild(errorCard(e.message, loadCustomers)); }
    }
  }

  function paintCustomers() {
    const stats = $("#cust-stats"), holder = $("#cust-holder");
    if (!holder) return;
    const list = S.customers.list;

    if (stats) {
      clear(stats);
      const repeat = list.filter((c) => c.bookings_count > 1).length;
      const revenue = list.reduce((a, c) => a + c.total_spent_cents, 0);
      const saved = list.reduce((a, c) => a + c.discount_total_cents, 0);
      stats.appendChild(stat("Customers", list.length, S.customers.q ? "matching your search" : "everyone who ever booked"));
      stats.appendChild(stat("Repeat customers", repeat, "booked more than once"));
      stats.appendChild(stat("Lifetime revenue", euros(revenue), "net of discounts"));
      stats.appendChild(stat("Discounts given", euros(saved), "total saved by guests"));
    }

    clear(holder);
    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "card-head" }, [
      el("h2", { text: "Customers" }),
      el("span", { class: "count-badge", text: list.length + (list.length === 1 ? " person" : " people") })
    ]));
    if (list.length === 0) {
      card.appendChild(el("div", { class: "empty" }, [
        el("div", { class: "big", text: "👤" }),
        el("div", { text: S.customers.q ? "No customers match “" + S.customers.q + "”." : "No customers yet — everyone appears here with their first booking." })
      ]));
      holder.appendChild(card);
      return;
    }
    const scroll = el("div", { class: "table-scroll" });
    const t = el("table", { class: "data" });
    t.appendChild(el("thead", {}, el("tr", {}, [
      th("Customer"), th("Email"), th("Bookings"), th("Total spent"), th("Discount"), th("Last booking")
    ])));
    const tb = el("tbody");
    list.forEach((c) => {
      const codes = S.customers.codes[c.email] || [];
      const discCell = el("td", {});
      if (c.discount_total_cents > 0 || codes.length > 0) {
        discCell.appendChild(el("span", { class: "disc-tag" }, [
          codes.length ? codes.join(", ") : "discount",
          el("b", { text: "−" + euros(c.discount_total_cents) })
        ]));
      } else {
        discCell.appendChild(el("span", { class: "td-sub", text: "—" }));
      }
      tb.appendChild(el("tr", { onclick: () => openCustomerDrawer(c.email) }, [
        el("td", {}, [el("div", { class: "td-name", text: c.name || "(no name)" }), el("div", { class: "td-sub", text: c.phone || "" })]),
        el("td", { class: "td-sub", text: c.email }),
        el("td", {}, [el("div", { class: "td-name num", text: c.bookings_count }), el("div", { class: "td-sub num", text: c.guests + " guest" + (c.guests === 1 ? "" : "s") })]),
        el("td", { class: "num td-name", text: euros(c.total_spent_cents) }),
        discCell,
        el("td", { class: "td-sub num", text: c.last_booking ? prettyDate(c.last_booking) : "—" })
      ]));
    });
    t.appendChild(tb);
    scroll.appendChild(t);
    card.appendChild(scroll);
    holder.appendChild(card);
  }

  async function openCustomerDrawer(email) {
    let data;
    try { data = await api("/admin/api/customers/" + encodeURIComponent(email)); }
    catch (e) { if (e.message !== "unauthenticated") toast(e.message, "err"); return; }
    const c = data.customer, hist = data.bookings || [];

    $("#drawer-title").textContent = c.name || c.email;
    const body = $("#drawer-body");
    clear(body);

    const codes = S.customers.codes[c.email] || [];
    const kv = el("dl", { class: "kv" });
    [
      ["Email", c.email],
      ["Phone", c.phone || "—"],
      ["Bookings", c.bookings_count + " (" + c.guests + " guest" + (c.guests === 1 ? "" : "s") + ")"],
      ["Total spent", euros(c.total_spent_cents)],
      ["Saved", c.discount_total_cents > 0 ? "−" + euros(c.discount_total_cents) + (codes.length ? "  (" + codes.join(", ") + ")" : "") : "—"],
      ["First booking", c.first_booking ? prettyDate(c.first_booking) : "—"],
      ["Last booking", c.last_booking ? prettyDate(c.last_booking) : "—"]
    ].forEach((row) => { kv.appendChild(el("dt", { text: row[0] })); kv.appendChild(el("dd", { text: row[1] })); });
    body.appendChild(kv);

    // -- edit form (opens via the “Edit details” button below) --
    const nameI = el("input", { type: "text", value: c.name || "" });
    const emailI = el("input", { type: "email", value: c.email });
    const phoneI = el("input", { type: "tel", value: c.phone || "" });
    const editErr = el("div", { class: "form-error", role: "alert" });
    const editWrap = el("div", { class: "cust-edit" }, [
      el("div", { class: "subhead", style: "margin-top:0", text: "Edit details" }),
      editErr,
      field("Name", nameI), field("Email", emailI), field("Phone", phoneI),
      el("p", { class: "capacity-hint", text: "Saving fixes it on every booking this customer has — one edit, their whole history follows." }),
      el("div", { style: "display:flex;gap:10px" }, [
        el("button", { class: "btn btn-primary btn-sm", text: "Save changes", onclick: async (ev) => {
          const btn = ev.currentTarget; btn.disabled = true;
          editErr.classList.remove("show");
          try {
            const patch = { name: nameI.value.trim(), phone: phoneI.value.trim() || null };
            const newEmail = emailI.value.trim().toLowerCase();
            if (newEmail && newEmail !== c.email) patch.email = newEmail;
            const res = await api("/admin/api/customers/" + encodeURIComponent(c.email), { method: "PUT", body: patch });
            toast("Saved — updated " + res.updated + " booking" + (res.updated === 1 ? "" : "s"), "ok");
            S.customers.loaded = false;
            S.customers.codesLoaded = false;
            S.bookings.list = [];            // bookings table refetches with the new details
            S.week.loadedStart = null;       // week grid too
            if (S.view === "customers") renderCustomers($("#view"));
            openCustomerDrawer(patch.email || c.email);
          } catch (e) {
            editErr.textContent = e.message;
            editErr.classList.add("show");
            btn.disabled = false;
          }
        } }),
        el("button", { class: "btn btn-ghost btn-sm", text: "Cancel", onclick: () => editWrap.classList.remove("show") })
      ])
    ]);
    body.appendChild(editWrap);

    body.appendChild(el("div", { class: "subhead", text: "Booking history" }));
    hist.forEach((b) => {
      body.appendChild(el("div", { class: "cust-bk" }, [
        el("div", {}, [
          el("div", { class: "td-name num", text: prettyDate(b.date) + " · " + b.slot }),
          el("div", { class: "td-sub" }, el("span", { class: "route-tag" }, [dot(b.route_id), shortRoute(b.route_name || b.route_id)]))
        ]),
        el("div", { class: "cust-bk-right" }, [
          el("span", { class: "count-badge", text: b.party + " " + (b.party === 1 ? "guest" : "guests") }),
          el("div", { class: "cust-bk-tags" }, [
            badge(b.status),
            b.source === "manual" ? el("span", { class: "tag-mini src", text: "Manual" }) : null,
            b.payment_status ? el("span", { class: "tag-mini pay", text: prettyPayment(b.payment_status) }) : null,
            (b.discount_code || b.discount_cents > 0) ? el("span", { class: "tag-mini disc", text: (b.discount_code || "discount") + " −" + euros(b.discount_cents || 0) }) : null
          ].filter(Boolean))
        ])
      ]));
    });

    const foot = $("#drawer-foot");
    clear(foot);
    foot.appendChild(el("button", { class: "btn btn-quiet", text: "Edit details", onclick: () => {
      editWrap.classList.toggle("show");
      if (editWrap.classList.contains("show")) nameI.focus();
    } }));
    foot.appendChild(el("button", { class: "btn btn-ghost", text: "Close", onclick: closeDrawer }));

    $("#drawer").classList.add("show");
    $("#drawer").setAttribute("aria-hidden", "false");
    $("#drawer-scrim").classList.add("show");
  }

  function prettyPayment(p) { return { paid_invoice: "Paid on invoice", free: "Free", comp: "Comp (on the house)" }[p] || p; }

  /* -- “Add customer + manual booking” — a phone booking IS the customer’s
        first (or next) row, guarded by the same atomic seat check as the
        widget. 409 sold-out errors surface inline, with the seats left. -- */
  function manualBookingCard(root) {
    const nameI = el("input", { type: "text", id: "mb-name", placeholder: "Guest name" });
    const emailI = el("input", { type: "email", placeholder: "guest@email.com" });
    const phoneI = el("input", { type: "tel", placeholder: "+31 6 …" });
    const partyI = el("input", { type: "number", min: "1", step: "1", value: "2" });
    const dateI = el("input", { type: "date", value: todayStr() });
    const slotSel = el("select");
    const routeSel = el("select", {}, S.routes.map((r) => el("option", { value: r.id, text: r.name + (r.active ? "" : " (hidden)") })));
    function syncSlots() {
      clear(slotSel);
      const r = routeById(routeSel.value);
      let parsed = [];
      try { parsed = JSON.parse((r && r.slots) || "[]"); } catch (e) { parsed = []; }
      let slots;
      if (Array.isArray(parsed)) slots = parsed.slice();
      else if (parsed && typeof parsed === "object") slots = (parsed[String(isoDow(dateI.value || todayStr()))] || []).slice();
      else slots = [];
      slots.sort().forEach((s) => slotSel.appendChild(el("option", { value: s, text: s })));
    }
    routeSel.addEventListener("change", syncSlots);
    dateI.addEventListener("change", syncSlots);
    syncSlots();
    const paySel = el("select", {}, [
      el("option", { value: "paid_invoice", text: "Paid on invoice" }),
      el("option", { value: "free", text: "Free" }),
      el("option", { value: "comp", text: "Comp (on the house)" })
    ]);
    const discCodeI = el("input", { type: "text", placeholder: "e.g. WELCOME10 — optional" });
    const discAmtI = el("input", { type: "number", min: "0", step: "0.05", placeholder: "0,00 — optional" });
    const notesI = el("textarea", { rows: "2", maxlength: "500", placeholder: "Nut allergy, wheelchair access, celebrating a birthday… — optional" });
    const errBox = el("div", { class: "form-error", role: "alert", "aria-live": "assertive" });

    const closeForm = () => { S.customers.formOpen = false; renderCustomers(root); };
    const card = el("div", { class: "card", style: "margin-bottom:18px" });
    card.appendChild(el("div", { class: "card-head" }, [
      el("h2", { text: "New manual booking (phone)" }),
      el("div", { class: "grow" }),
      el("button", { class: "icon-btn", "aria-label": "Cancel", text: "✕", onclick: closeForm })
    ]));
    const bodyEl = el("div", { style: "padding:18px" });
    bodyEl.appendChild(errBox);
    bodyEl.appendChild(el("div", { class: "form-grid" }, [
      field("Guest name", nameI),
      field("Email (gets the confirmation)", emailI),
      field("Phone", phoneI),
      field("Route", routeSel),
      field("Date", dateI),
      field("Start time", slotSel),
      field("Guests", partyI),
      field("Payment", paySel),
      field("Discount code", discCodeI),
      field("Discount (€)", discAmtI),
      field("Allergies / notes (goes to the bars)", notesI)
    ]));
    bodyEl.appendChild(el("div", { class: "rc-actions" }, [
      el("p", { class: "capacity-hint", style: "padding:0;margin:0;align-self:center;max-width:420px", text: "Same seat protection as the website — you can never oversell a bar. The guest gets the normal confirmation email; each bar gets its arrival notice." }),
      el("div", { class: "grow" }),
      el("button", { class: "btn btn-ghost", text: "Cancel", onclick: closeForm }),
      el("button", { class: "btn btn-primary", text: "Add booking", onclick: async (ev) => {
        const btn = ev.currentTarget;
        errBox.classList.remove("show");
        const fail = (msg) => { errBox.textContent = msg; errBox.classList.add("show"); errBox.scrollIntoView({ block: "nearest" }); };
        const name = nameI.value.trim(), email = emailI.value.trim();
        const party = parseInt(partyI.value, 10);
        if (!name) return fail("Enter the guest’s name.");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email — the confirmation goes there.");
        if (!dateI.value) return fail("Pick a date.");
        if (!slotSel.value) return fail("This route has no start times yet — add them in Route manager first.");
        if (!(party >= 1)) return fail("Guests must be at least 1.");
        btn.disabled = true; btn.textContent = "Booking…";
        const payload = {
          route_id: routeSel.value, date: dateI.value, slot: slotSel.value, party,
          name, email, payment_status: paySel.value
        };
        if (phoneI.value.trim()) payload.phone = phoneI.value.trim();
        if (notesI.value.trim()) payload.notes = notesI.value.trim();
        const code = discCodeI.value.trim();
        const amt = Math.round((parseFloat(discAmtI.value) || 0) * 100);
        if (code) payload.discount_code = code;
        if (amt > 0) payload.discount_cents = amt;
        try {
          const d = await api("/admin/api/bookings/manual", { method: "POST", body: payload });
          const r = routeById(routeSel.value);
          toast("Booked " + party + " guest" + (party === 1 ? "" : "s") + " · " + (r ? shortRoute(r.name) : "") + " " + prettyDate(dateI.value) + " " + slotSel.value + " — confirmation sent", "ok");
          S.customers.formOpen = false;
          S.customers.loaded = false;
          S.customers.codesLoaded = false;
          S.bookings.list = [];            // bookings list refetches next visit
          S.week.loadedStart = null;       // week grid refetches next visit
          renderCustomers(root);
          if (d && d.booking) openDrawer(d.booking);
        } catch (e) {
          fail(e.message.indexOf("seat") >= 0
            ? "No room on that departure — " + e.message + ". Pick another time, lower the group size, or raise its seats under Per hour."
            : e.message);
          btn.disabled = false; btn.textContent = "Add booking";
        }
      } })
    ]));
    card.appendChild(bodyEl);
    return card;
  }

  /* ======================================================================
     shared components
     ====================================================================== */
  function chip(label, active, dotEl, onClick, noDot) {
    return el("button", { class: "chip" + (active ? " active" : ""), type: "button", onclick: onClick },
      [noDot ? null : dotEl, label].filter(Boolean));
  }
  function segBtn(label, active, onClick) { return el("button", { class: active ? "active" : "", type: "button", text: label, onclick: onClick }); }
  function selectField(label, _, options, onChange, value) {
    const sel = el("select", { onchange: (e) => onChange(e.target.value) }, options.map((o) => {
      const opt = el("option", { value: o, text: o }); if (o === value) opt.selected = true; return opt;
    }));
    return el("div", { class: "filter-group" }, [el("label", { text: label }), sel]);
  }
  function dateField(label, value, onChange) {
    const inp = el("input", { type: "date", value: value || "" });
    inp.addEventListener("change", () => onChange(inp.value));
    return el("div", { class: "filter-group" }, [el("label", { text: label }), inp]);
  }
  function field(label, input, extra) { return el("div", { class: "field" + (extra ? " " + extra : "") }, [el("label", { text: label }), input]); }

  /* ---------- currency + timezone pickers (migrations/0011) --------------
     Curated to WOGO's near-term city roadmap (NL = EUR/Amsterdam today;
     London imminent = GBP/Europe London; New York later = USD/America New
     York) — the current value is always kept as an option even if it isn't
     one of these, so an unusual value round-trips instead of silently
     resetting. Add a new city's code/zone to these two arrays when it's
     ready to book (see backend/ADD-A-CITY.md). */
  const CURRENCY_OPTIONS = ["EUR", "GBP", "USD"];
  const TIMEZONE_OPTIONS = ["Europe/Amsterdam", "Europe/London", "America/New_York"];
  function currencySelect(current) {
    const codes = CURRENCY_OPTIONS.slice();
    if (current && codes.indexOf(current) < 0) codes.push(current);
    const sel = el("select", {}, codes.map((c) => el("option", { value: c, text: c })));
    sel.value = current || "EUR";
    return sel;
  }
  function timezoneSelect(current) {
    const zones = TIMEZONE_OPTIONS.slice();
    if (current && zones.indexOf(current) < 0) zones.push(current);
    const sel = el("select", {}, zones.map((z) => el("option", { value: z, text: z })));
    sel.value = current || "Europe/Amsterdam";
    return sel;
  }
  function th(t) { return el("th", { scope: "col", text: t }); }
  function badge(status) { return el("span", { class: "badge " + status, text: prettyStatus(status) }); }
  function prettyStatus(s) { return { confirmed: "Confirmed", hold: "Hold", cancelled: "Cancelled", expired: "Expired", confirmed_conflict: "Conflict" }[s] || s; }
  function stat(k, v, d) { return el("div", { class: "stat" }, [el("div", { class: "k", text: k }), el("div", { class: "v", text: v }), el("div", { class: "d", text: d })]); }
  function shortRoute(name) {
    const s = String(name || "");
    const m = /^Rotterdam Route (\d+)/.exec(s);          // "Rotterdam Route 2 · Hidden Gems" → "Route 2"
    if (m) return "Route " + m[1] + (/premium/i.test(s) ? " Premium" : "");
    if (/^Rotterdam Premium/i.test(s)) return "Route 3 Premium";
    return s.replace(/^WOGO Cocktail Walk /, "").replace(/ \(best seller\)/, "").replace(/^Rotterdam /, "");
  }
  function skeletonCard() { const c = el("div", { class: "card" }); for (let i = 0; i < 6; i++) c.appendChild(el("div", { class: "skeleton sk-row" })); return c; }
  function skeletonRows(n) { const w = el("div"); for (let i = 0; i < n; i++) w.appendChild(el("div", { class: "skeleton sk-row" })); return w; }
  function errorCard(msg, retry) {
    return el("div", { class: "card" }, el("div", { class: "empty" }, [
      el("div", { class: "big", text: "⚠️" }),
      el("div", { text: msg }),
      el("div", { style: "margin-top:14px" }, el("button", { class: "btn btn-quiet btn-sm", text: "Try again", onclick: retry }))
    ]));
  }
  function shiftMonth(m, delta) { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 1 + delta, 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }

  /* ======================================================================
     boot
     ====================================================================== */
  async function boot() {
    try {
      const data = await api("/admin/api/routes");
      S.routes = data.routes || [];
      assignColors();
      showApp();
      go("bookings");
    } catch (e) {
      if (e.message === "unauthenticated") showLogin();
      else { showLogin(); toast(e.message, "err"); }
    }
  }

  boot();
})();
