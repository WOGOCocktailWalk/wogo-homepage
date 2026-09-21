/* ============================================================================
   WOGO GUEST CALENDAR  ·  wogo-calendar.js
   Vanilla, zero-dependency, self-contained booking widget.

   ── THE ONE SWITCH ────────────────────────────────────────────────────────
   WOGO_API is the single line that turns this widget on. While it is an EMPTY
   STRING the widget is DORMANT: init() returns immediately and touches no DOM,
   so a route page's existing Wix "Book now" button is left completely alone.
   Set it to the deployed Worker URL (e.g. "https://api.wogococktailwalk.com")
   to activate the calendar on every page that has a mount element.
   ────────────────────────────────────────────────────────────────────────── */
const WOGO_API = "https://wogo-booking-backend.purple-glitter-720e.workers.dev";

/* Mount contract:  <div class="wogo-calendar" data-route="rotterdam-hidden-gems"></div>
   Language comes from data-lang, else <html lang>, else "en".                 */

(function () {
  "use strict";

  /* ---- Localised strings (mirrors the site's data-i18n phrasing) ---------- */
  const STRINGS = {
    en: {
      price_from: "From", per_person: "per person",
      prev_month: "Previous month", next_month: "Next month",
      dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      dow_full: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      months: ["January", "February", "March", "April", "May", "June", "July",
        "August", "September", "October", "November", "December"],
      legend_open: "Available", legend_soldout: "Sold out",
      pick_day: "Pick a date to see times",
      loading: "Loading availability…",
      day_available: "%s — available", day_soldout: "%s — sold out",
      day_closed: "%s — no walks",
      choose_time: "Choose a time", back: "Change date",
      includes_head: "Tickets include",
      inc_cocktails: "3 cocktails", inc_bars: "3 hand-picked bars",
      inc_map: "Digital route map", inc_tables: "Tables reserved",
      seats_left: "%n seats left", one_seat_left: "1 seat left",
      only_left: "Only %n left", soldout: "Sold out",
      your_details: "Your details", party: "How many guests?",
      guest: "guest", guests: "guests", max_reached: "Max %n per booking",
      name: "Full name", name_ph: "Anna de Vries",
      email: "Email", email_ph: "you@email.com",
      phone: "Mobile (optional)", phone_ph: "+31 6 12345678",
      notes: "Allergies or notes (optional)",
      notes_ph: "Nut allergy, wheelchair access, celebrating a birthday…",
      optin: "Send me the occasional WOGO tip — no spam, unsubscribe anytime.",
      total: "Total", book: "Continue to secure payment",
      redirecting: "Taking you to secure checkout…",
      fine: "You'll pay securely via Stripe — iDEAL, card, Apple Pay or Klarna. Your table is only reserved once payment completes.",
      err_name: "Please enter your name.",
      err_email: "Please enter a valid email.",
      err_load: "We couldn't load availability. Please try again.",
      err_book: "Something went wrong. Your card was not charged — please try again.",
      err_soldout: "Sorry, that time just sold out. Please pick another.",
      retry: "Try again",
      status_month: "Showing availability for %s.",
      status_slots: "%s selected. Choose a time below.",
      status_form: "%s at %t selected. Enter your details to book.",
      step_date: "Date", step_time: "Time", step_details: "Details",
      placeholder_note: "Live booking opens when this city launches.",
    },
    nl: {
      price_from: "Vanaf", per_person: "per persoon",
      prev_month: "Vorige maand", next_month: "Volgende maand",
      dow: ["ma", "di", "wo", "do", "vr", "za", "zo"],
      dow_full: ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"],
      months: ["januari", "februari", "maart", "april", "mei", "juni", "juli",
        "augustus", "september", "oktober", "november", "december"],
      legend_open: "Beschikbaar", legend_soldout: "Uitverkocht",
      pick_day: "Kies een datum voor de tijden",
      loading: "Beschikbaarheid laden…",
      day_available: "%s — beschikbaar", day_soldout: "%s — uitverkocht",
      day_closed: "%s — geen walks",
      choose_time: "Kies een tijd", back: "Datum wijzigen",
      includes_head: "Inclusief",
      inc_cocktails: "3 cocktails", inc_bars: "3 geselecteerde bars",
      inc_map: "Digitale routekaart", inc_tables: "Tafels gereserveerd",
      seats_left: "%n plekken vrij", one_seat_left: "nog 1 plek",
      only_left: "Nog maar %n vrij", soldout: "Uitverkocht",
      your_details: "Jouw gegevens", party: "Hoeveel gasten?",
      guest: "gast", guests: "gasten", max_reached: "Max %n per boeking",
      name: "Volledige naam", name_ph: "Anna de Vries",
      email: "E-mail", email_ph: "jij@email.com",
      phone: "Mobiel (optioneel)", phone_ph: "+31 6 12345678",
      notes: "Allergieën of opmerkingen (optioneel)",
      notes_ph: "Notenallergie, rolstoeltoegang, een verjaardag vieren…",
      optin: "Stuur me af en toe een WOGO-tip — geen spam, altijd uitschrijfbaar.",
      total: "Totaal", book: "Naar veilig betalen",
      redirecting: "Je gaat naar de beveiligde betaalpagina…",
      fine: "Je betaalt veilig via Stripe — iDEAL, kaart, Apple Pay of Klarna. Je tafel is pas gereserveerd zodra de betaling rond is.",
      err_name: "Vul je naam in.",
      err_email: "Vul een geldig e-mailadres in.",
      err_load: "We konden de beschikbaarheid niet laden. Probeer opnieuw.",
      err_book: "Er ging iets mis. Er is niets afgeschreven — probeer opnieuw.",
      err_soldout: "Helaas, die tijd is net uitverkocht. Kies een andere.",
      retry: "Opnieuw proberen",
      status_month: "Beschikbaarheid voor %s.",
      status_slots: "%s geselecteerd. Kies hieronder een tijd.",
      status_form: "%s om %t geselecteerd. Vul je gegevens in om te boeken.",
      step_date: "Datum", step_time: "Tijd", step_details: "Gegevens",
      placeholder_note: "Online boeken opent zodra deze stad live gaat.",
    },
  };

  /* "Tickets include" reassurance shown the moment a timeslot is chosen —
     mirrors the route pages' blush ticket card. Route-agnostic default; a
     route may override it later via an `includes` array on /api/routes
     (items: {icon, en, nl} or {icon, label}). Emoji are decorative
     (aria-hidden); the labels carry the meaning. */
  const DEFAULT_INCLUDES = [
    { icon: "🍸", key: "inc_cocktails" },
    { icon: "🍹", key: "inc_bars" },
    { icon: "🗺️", key: "inc_map" },
    { icon: "🪑", key: "inc_tables" },
  ];

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const HORIZON_DAYS = 90;
  const LOW_SEATS = 3; // "only N left" urgency threshold

  /* ---- tiny helpers ------------------------------------------------------- */
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const isoWeekday = (d) => ((d.getDay() + 6) % 7) + 1; // Mon=1..Sun=7
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const fmt = (tpl, map) => tpl.replace(/%[a-z]/g, (k) => (k in map ? map[k] : k));
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  // Currency-aware price formatter — mirrors the engine's formatMoney()
  // (src/logic.js) byte-for-byte so the widget shows exactly what Stripe
  // charges: EUR "€29,95" (comma decimal), GBP "£29.95" / USD "$29.95"
  // (point decimal), symbol always before the amount. The route's currency
  // (from /api/routes, migrations/0011) is the single source of truth; an
  // unlisted ISO code still formats sanely as "CODE 29.95". Locale-independent
  // on purpose, so NL and EN visitors see the same figure the backend does.
  const CURRENCY_FORMATS = {
    EUR: { symbol: "€", decimal: "," },
    GBP: { symbol: "£", decimal: "." },
    USD: { symbol: "$", decimal: "." },
  };
  const money = (cents, currency) => {
    const code = String(currency || "EUR").toUpperCase();
    const f = CURRENCY_FORMATS[code] || { symbol: code + " ", decimal: "." };
    const amount = ((Number(cents) || 0) / 100).toFixed(2).replace(".", f.decimal);
    return `${f.symbol}${amount}`;
  };

  /* ---- the widget --------------------------------------------------------- */
  class WogoCalendar {
    constructor(mount, opts) {
      opts = opts || {};
      this.mount = mount;
      this.api = (opts.api != null ? opts.api : WOGO_API).replace(/\/$/, "");
      this._fetch = opts.fetchImpl || ((...a) => fetch(...a));
      this.routeId = mount.getAttribute("data-route") || opts.route;
      const lang = (mount.getAttribute("data-lang") ||
        document.documentElement.lang || "en").slice(0, 2).toLowerCase();
      this.lang = STRINGS[lang] ? lang : "en";
      this.t = STRINGS[this.lang];

      this.hideTitle = mount.getAttribute("data-hide-title") === "1";
      this._auto = false; this._autoStep = 0; this.step = 0;

      this.route = null;        // {name, price_cents, max_party, ...}
      this.month = startOfDay(new Date()); this.month.setDate(1);
      this.availability = {};   // {date: 'open'|'closed'|'soldout'}
      this.selectedDate = null;
      this.selectedSlot = null;
      this.slots = [];          // [{slot, capacity, seats_left}]
      this.party = 2;
    }

    /* ---- lifecycle -------------------------------------------------------- */
    async init() {
      if (!this.routeId) return;
      this.renderShell();
      this.setLoading();
      try {
        await this.loadRoute();
        if (this.route && this.route._placeholder) { this.renderPlaceholder(); return; }
        this._auto = true; this._autoStep = 0;
        await this.loadMonth();
      } catch (e) {
        this.renderError();
      }
    }

    async loadRoute() {
      // A single-route page only knows its slug — fetch the route meta so we
      // can show price + clamp party size. Cached after first call.
      const res = await this._fetch(`${this.api}/api/routes`);
      if (!res.ok) throw new Error("routes_failed");
      const data = await res.json();
      const found = (data.routes || []).find((r) => r.id === this.routeId);
      if (found) {
        this.route = found;
      } else {
        // Route not in the engine yet — e.g. a PLACEHOLDER city page (London)
        // whose backend route isn't seeded. Fall back to the mount's data-*
        // so the example still shows the right price + currency. When the
        // mount is explicitly flagged data-placeholder="1", init() shows a
        // "launching soon" card instead of hard-erroring on availability.
        const pc = parseInt(this.mount.getAttribute("data-price-cents"), 10);
        const mp = parseInt(this.mount.getAttribute("data-max-party"), 10);
        this.route = {
          id: this.routeId,
          name: this.mount.getAttribute("data-name") || "WOGO Cocktail Walk",
          city: this.mount.getAttribute("data-city") || "",
          price_cents: pc > 0 ? pc : 2995,
          max_party: mp > 0 ? mp : 6,
          currency: (this.mount.getAttribute("data-currency") || "EUR").toUpperCase(),
          _placeholder: this.mount.getAttribute("data-placeholder") === "1",
        };
      }
      this.party = Math.min(2, this.route.max_party);
    }

    async loadMonth() {
      this.setLoading();
      const m = `${this.month.getFullYear()}-${pad(this.month.getMonth() + 1)}`;
      const res = await this._fetch(`${this.api}/api/availability?route=${encodeURIComponent(this.routeId)}&month=${m}`);
      if (!res.ok) throw new Error("availability_failed");
      const data = await res.json();
      this.availability = data.days || {};
      this.selectedDate = null; this.selectedSlot = null; this.slots = [];

      // Fewest taps to a valid date: on the first open, skip past any month with
      // no openings so the guest lands on one that has dates to pick (max 3 hops).
      if (this._auto && this._autoStep < 3) {
        const hasOpen = Object.keys(this.availability).some((k) => this.availability[k] === "open");
        const horizon = startOfDay(new Date()); horizon.setDate(horizon.getDate() + HORIZON_DAYS);
        const nextStart = new Date(this.month.getFullYear(), this.month.getMonth() + 1, 1);
        if (!hasOpen && nextStart <= new Date(horizon.getFullYear(), horizon.getMonth(), 1)) {
          this._autoStep++; this.month.setMonth(this.month.getMonth() + 1);
          return this.loadMonth();
        }
        this._auto = false;
      }

      this.renderCalendar();
      this.announce(fmt(this.t.status_month, { "%s": this.monthLabel() }));
    }

    async loadSlots(date) {
      const res = await this._fetch(`${this.api}/api/slots?route=${encodeURIComponent(this.routeId)}&date=${date}`);
      if (!res.ok) throw new Error("slots_failed");
      return res.json();
    }

    /* ---- shell + skeleton ------------------------------------------------- */
    renderShell() {
      this.mount.innerHTML = "";
      this.card = el("div", "wc-card");
      this.mount.appendChild(this.card);
    }

    /* ---- progress cue: Date · Time · Details ------------------------------ */
    renderProgress() {
      const labels = [this.t.step_date, this.t.step_time, this.t.step_details];
      const wrap = el("div", "wc-steps");
      wrap.setAttribute("aria-hidden", "true"); // the wc-status region already speaks to AT
      this.stepEls = labels.map((label, i) => {
        const s = el("div", "wc-step");
        s.appendChild(el("span", "wc-step-num", String(i + 1)));
        s.appendChild(el("span", "wc-step-lb", label));
        wrap.appendChild(s);
        return s;
      });
      this._paintStep();
      return wrap;
    }
    setStep(i) { this.step = i; this._paintStep(); }
    _paintStep() {
      if (!this.stepEls) return;
      this.stepEls.forEach((s, i) => {
        s.classList.toggle("wc-step--on", i === this.step);
        s.classList.toggle("wc-step--done", i < this.step);
      });
    }

    monthLabel() {
      return `${this.t.months[this.month.getMonth()]} ${this.month.getFullYear()}`;
    }

    setLoading() {
      this.card.innerHTML = "";
      const head = el("div", "wc-head");
      if (!this.hideTitle) {
      head.appendChild(el("div", "wc-eyebrow", (this.route && this.route.city) || "WOGO"));
      head.appendChild(el("div", "wc-title", (this.route && this.route.name) || " "));
      }
      this.card.appendChild(head);
      const status = el("div", "wc-status", this.t.loading);
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      this.card.appendChild(status);
      const skel = el("div", "wc-skel-grid");
      for (let i = 0; i < 35; i++) skel.appendChild(el("div", "wc-skel"));
      this.card.appendChild(skel);
    }

    /* PLACEHOLDER card — a not-yet-launched city (e.g. London example). Shows the
       price + currency exactly as the live widget would, plus a "launching soon"
       note, instead of hard-erroring on the missing availability endpoint. */
    renderPlaceholder() {
      this.card.innerHTML = "";
      const head = el("div", "wc-head");
      if (!this.hideTitle) {
        head.appendChild(el("div", "wc-eyebrow", this.route.city || "WOGO"));
        head.appendChild(el("div", "wc-title", this.route.name));
      }
      if (this.route.price_cents) {
        const p = el("div", "wc-price");
        p.innerHTML = `${this.t.price_from} <b>${money(this.route.price_cents, this.route.currency)}</b> ${this.t.per_person}`;
        head.appendChild(p);
      }
      this.card.appendChild(head);
      const note = el("div", "wc-status", this.t.placeholder_note);
      note.setAttribute("role", "status");
      this.card.appendChild(note);
      this.announce(this.t.placeholder_note);
    }

    renderError() {
      this.card.innerHTML = "";
      const box = el("div", "wc-errbox");
      box.appendChild(el("p", null, this.t.err_load));
      const btn = el("button", "wc-retry", this.t.retry);
      btn.type = "button";
      btn.addEventListener("click", () => this.init());
      box.appendChild(btn);
      this.card.appendChild(box);
      this.announce(this.t.err_load);
    }

    /* ---- the calendar ----------------------------------------------------- */
    renderCalendar() {
      this.card.innerHTML = "";
      this.step = 0; // fresh month = back at "pick a date"

      // header
      const head = el("div", "wc-head");
      if (!this.hideTitle) {
      head.appendChild(el("div", "wc-eyebrow", this.route.city || "WOGO"));
      head.appendChild(el("div", "wc-title", this.route.name));
      }
      if (this.route.price_cents) {
        const p = el("div", "wc-price");
        p.innerHTML = `${this.t.price_from} <b>${money(this.route.price_cents, this.route.currency)}</b> ${this.t.per_person}`;
        head.appendChild(p);
      }
      this.card.appendChild(head);

      // progress cue (Date · Time · Details) — a visible mirror of the aria-live status
      this.card.appendChild(this.renderProgress());

      // live status region
      this.status = el("div", "wc-status");
      this.status.setAttribute("role", "status");
      this.status.setAttribute("aria-live", "polite");
      this.card.appendChild(this.status);

      // month nav
      const bar = el("div", "wc-monthbar");
      const today = startOfDay(new Date());
      const prev = el("button", "wc-navbtn", "‹");
      prev.type = "button"; prev.setAttribute("aria-label", this.t.prev_month);
      prev.disabled = this.month <= new Date(today.getFullYear(), today.getMonth(), 1);
      prev.addEventListener("click", () => { this._auto = false; this.month.setMonth(this.month.getMonth() - 1); this.loadMonth(); });
      const maxMonth = startOfDay(new Date()); maxMonth.setDate(maxMonth.getDate() + HORIZON_DAYS);
      const next = el("button", "wc-navbtn", "›");
      next.type = "button"; next.setAttribute("aria-label", this.t.next_month);
      next.disabled = this.month >= new Date(maxMonth.getFullYear(), maxMonth.getMonth(), 1);
      next.addEventListener("click", () => { this._auto = false; this.month.setMonth(this.month.getMonth() + 1); this.loadMonth(); });
      const label = el("div", "wc-monthlabel", this.monthLabel());
      label.setAttribute("aria-live", "polite");
      bar.appendChild(prev); bar.appendChild(label); bar.appendChild(next);
      this.card.appendChild(bar);

      // weekday header
      const dow = el("div", "wc-dow");
      dow.setAttribute("aria-hidden", "true");
      this.t.dow.forEach((d) => dow.appendChild(el("span", null, d)));
      this.card.appendChild(dow);

      // day grid
      const grid = el("div", "wc-grid");
      const first = new Date(this.month.getFullYear(), this.month.getMonth(), 1);
      const lead = isoWeekday(first) - 1; // blank cells before day 1
      for (let i = 0; i < lead; i++) grid.appendChild(el("div", "wc-day wc-day--empty"));
      const daysInMonth = new Date(this.month.getFullYear(), this.month.getMonth() + 1, 0).getDate();
      for (let day = 1; day <= daysInMonth; day++) {
        grid.appendChild(this.dayCell(day, today));
      }
      this.card.appendChild(grid);

      // legend
      const legend = el("div", "wc-legend");
      const lo = el("span"); lo.appendChild(el("i", "wc-lg-open")); lo.appendChild(document.createTextNode(this.t.legend_open));
      const ls = el("span"); ls.appendChild(el("i", "wc-lg-soldout")); ls.appendChild(document.createTextNode(this.t.legend_soldout));
      legend.appendChild(lo); legend.appendChild(ls);
      this.card.appendChild(legend);

      this.slotHost = el("div"); // panels mount here
      this.card.appendChild(this.slotHost);
    }

    dayCell(day, today) {
      const date = new Date(this.month.getFullYear(), this.month.getMonth(), day);
      const ds = ymd(date);
      const state = this.availability[ds]; // undefined = not selectable
      const longLabel = `${this.t.dow_full[isoWeekday(date) - 1]} ${day} ${this.t.months[date.getMonth()]}`;

      if (!state) {
        const cell = el("div", "wc-day wc-day--empty", String(day));
        cell.setAttribute("aria-hidden", "true");
        return cell;
      }
      const cell = el("button", "wc-day wc-day--" + state);
      cell.type = "button";
      cell.appendChild(document.createTextNode(String(day)));
      if (ymd(today) === ds) cell.classList.add("wc-day--today");

      if (state === "open") {
        cell.appendChild(el("span", "wc-day-dot"));
        cell.setAttribute("aria-label", fmt(this.t.day_available, { "%s": longLabel }));
        cell.setAttribute("aria-pressed", "false");
        cell.addEventListener("click", () => this.selectDay(ds, cell));
      } else {
        cell.disabled = true;
        cell.setAttribute("aria-label",
          fmt(state === "soldout" ? this.t.day_soldout : this.t.day_closed, { "%s": longLabel }));
      }
      return cell;
    }

    dayLabel(ds) {
      const d = parseYmd(ds);
      return `${this.t.dow_full[isoWeekday(d) - 1]} ${d.getDate()} ${this.t.months[d.getMonth()]}`;
    }

    /* ---- step 2: slots ---------------------------------------------------- */
    async selectDay(ds, cell) {
      // toggle pressed state across all day buttons
      this.card.querySelectorAll('.wc-day[aria-pressed]').forEach((b) => b.setAttribute("aria-pressed", "false"));
      cell.setAttribute("aria-pressed", "true");
      this.selectedDate = ds; this.selectedSlot = null; this._dayCell = cell;
      this.slotHost.innerHTML = "";
      this.announce(fmt(this.t.status_slots, { "%s": this.dayLabel(ds) }));

      // loading placeholder
      const panel = el("div", "wc-panel");
      panel.appendChild(el("div", "wc-status", this.t.loading));
      this.slotHost.appendChild(panel);

      let data;
      try { data = await this.loadSlots(ds); }
      catch (e) { this.slotHost.innerHTML = ""; this.renderInlineError(); return; }
      this.slots = data.closed ? [] : (data.slots || []);
      this.renderSlots();
    }

    renderInlineError() {
      const panel = el("div", "wc-panel wc-errbox");
      panel.appendChild(el("p", null, this.t.err_load));
      const btn = el("button", "wc-retry", this.t.retry);
      btn.type = "button";
      btn.addEventListener("click", () => this.selectDay(this.selectedDate, this._dayCell));
      panel.appendChild(btn);
      this.slotHost.appendChild(panel);
    }

    renderSlots() {
      this.slotHost.innerHTML = "";
      const panel = el("div", "wc-panel");
      const ph = el("div", "wc-panel-head");
      ph.appendChild(el("div", "wc-panel-title", `${this.t.choose_time} · ${this.dayLabel(this.selectedDate)}`));
      panel.appendChild(ph);

      const list = el("div", "wc-slots");
      this.slots.forEach((s) => list.appendChild(this.slotCell(s)));
      panel.appendChild(list);
      this.slotHost.appendChild(panel);

      // focus first available slot for keyboard users
      const firstOpen = panel.querySelector(".wc-slot:not(.wc-slot--soldout)");
      if (firstOpen) firstOpen.focus();
      this.formHost = el("div");
      panel.appendChild(this.formHost);
      this.setStep(1); // a date is chosen, we're now picking a time
    }

    slotCell(s) {
      const soldout = s.seats_left <= 0;
      const btn = el("button", "wc-slot" + (soldout ? " wc-slot--soldout" : ""));
      btn.type = "button";
      btn.appendChild(el("span", "wc-slot-time", s.slot));
      let seatsTxt, low = false;
      if (soldout) seatsTxt = this.t.soldout;
      else if (s.seats_left === 1) { seatsTxt = this.t.one_seat_left; low = true; }
      else if (s.seats_left <= LOW_SEATS) { seatsTxt = fmt(this.t.only_left, { "%n": s.seats_left }); low = true; }
      else seatsTxt = fmt(this.t.seats_left, { "%n": s.seats_left });
      btn.appendChild(el("span", "wc-slot-seats" + (low ? " wc-low" : ""), seatsTxt));

      if (soldout) {
        btn.disabled = true;
        btn.setAttribute("aria-label", `${s.slot} — ${this.t.soldout}`);
      } else {
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", `${s.slot} — ${seatsTxt}`);
        btn.addEventListener("click", () => this.selectSlot(s, btn));
      }
      return btn;
    }

    /* ---- step 3: party + details ------------------------------------------ */
    selectSlot(s, btn) {
      this.slotHost.querySelectorAll('.wc-slot[aria-pressed]').forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      this.selectedSlot = s;
      this.party = Math.min(this.party, Math.min(this.route.max_party, s.seats_left));
      if (this.party < 1) this.party = 1;
      this.announce(fmt(this.t.status_form, { "%s": this.dayLabel(this.selectedDate), "%t": s.slot }));
      this.renderForm();
    }

    /* Compact "Tickets include" strip — re-rendered with the form, so it
       appears on the first slot pick and simply stays put (with fresh data)
       when the guest switches to another time. */
    renderIncludes() {
      const items = (this.route && Array.isArray(this.route.includes) && this.route.includes.length)
        ? this.route.includes
        : DEFAULT_INCLUDES;
      const wrap = el("div", "wc-includes");
      wrap.appendChild(el("div", "wc-includes-head", this.t.includes_head));
      const rows = el("ul", "wc-includes-rows");
      items.forEach((it) => {
        const label = it.key ? this.t[it.key] : (it[this.lang] || it.en || it.label || "");
        if (!label) return;
        const li = el("li", "wc-inc");
        if (it.icon) {
          const ico = el("span", "wc-inc-ico", it.icon);
          ico.setAttribute("aria-hidden", "true");
          li.appendChild(ico);
        }
        li.appendChild(el("span", null, label));
        rows.appendChild(li);
      });
      wrap.appendChild(rows);
      return wrap;
    }

    renderForm() {
      this.formHost.innerHTML = "";
      const t = this.t;
      const maxParty = Math.min(this.route.max_party, this.selectedSlot.seats_left);
      const panel = el("div", "wc-panel");

      // Reassurance at the moment of commitment: what the ticket includes,
      // right between the chosen time and the party-size step.
      panel.appendChild(this.renderIncludes());

      const ph = el("div", "wc-panel-head");
      ph.appendChild(el("div", "wc-panel-title", t.your_details));
      const back = el("button", "wc-back", t.back);
      back.type = "button";
      back.addEventListener("click", () => {
        this.formHost.innerHTML = "";
        this.slotHost.querySelectorAll('.wc-slot[aria-pressed]').forEach((b) => b.setAttribute("aria-pressed", "false"));
        this.setStep(1);
        if (this._dayCell) this._dayCell.focus();
      });
      ph.appendChild(back);
      panel.appendChild(ph);

      // party stepper
      const pf = el("div", "wc-field");
      pf.appendChild(el("label", "wc-label", t.party));
      const stepper = el("div", "wc-stepper");
      stepper.setAttribute("role", "group");
      stepper.setAttribute("aria-label", t.party);
      const minus = el("button", "wc-step-btn", "−"); minus.type = "button"; minus.setAttribute("aria-label", "−");
      const val = el("div", "wc-step-val"); val.setAttribute("aria-live", "polite");
      const plus = el("button", "wc-step-btn", "+"); plus.type = "button"; plus.setAttribute("aria-label", "+");
      const hint = el("span", "wc-step-hint");
      const syncParty = () => {
        val.textContent = String(this.party);
        val.setAttribute("aria-label", `${this.party} ${this.party === 1 ? t.guest : t.guests}`);
        minus.disabled = this.party <= 1;
        plus.disabled = this.party >= maxParty;
        hint.textContent = this.party >= maxParty ? fmt(t.max_reached, { "%n": maxParty }) : "";
        if (this.totalEl) this.totalEl.innerHTML =
          `${t.total} <b>${money(this.route.price_cents * this.party, this.route.currency)}</b>`;
      };
      minus.addEventListener("click", () => { if (this.party > 1) { this.party--; syncParty(); } });
      plus.addEventListener("click", () => { if (this.party < maxParty) { this.party++; syncParty(); } });
      stepper.appendChild(minus); stepper.appendChild(val); stepper.appendChild(plus);
      pf.appendChild(stepper); pf.appendChild(hint);
      panel.appendChild(pf);

      // name
      this.nameInput = this.textField(panel, "wc-name", t.name, "text", t.name_ph, "name");
      // email
      this.emailInput = this.textField(panel, "wc-email", t.email, "email", t.email_ph, "email");
      // phone
      this.phoneInput = this.textField(panel, "wc-phone", t.phone, "tel", t.phone_ph, "tel");
      // allergies / notes — optional free text, sent as `notes` on /api/book
      this.notesInput = this.textareaField(panel, "wc-notes", t.notes, t.notes_ph);

      // opt-in
      const optWrap = el("label", "wc-check");
      this.optIn = el("input"); this.optIn.type = "checkbox";
      optWrap.appendChild(this.optIn);
      optWrap.appendChild(el("span", null, t.optin));
      panel.appendChild(optWrap);

      // total
      this.totalEl = el("div", "wc-total");
      panel.appendChild(this.totalEl);

      // book
      const book = el("button", "wc-book", t.book);
      book.type = "button";
      book.addEventListener("click", () => this.submit(book));
      panel.appendChild(book);
      panel.appendChild(el("div", "wc-fine", t.fine));

      this.formHost.appendChild(panel);
      this.setStep(2); // details step
      syncParty();
      this.nameInput.el.focus();
    }

    textField(parent, id, label, type, placeholder, autocomplete) {
      const wrap = el("div", "wc-field");
      const lab = el("label", "wc-label", label);
      lab.setAttribute("for", id);
      const input = el("input", "wc-input");
      input.id = id; input.type = type; input.placeholder = placeholder;
      input.setAttribute("autocomplete", autocomplete);
      const err = el("div", "wc-error");
      input.setAttribute("aria-describedby", id + "-err");
      err.id = id + "-err";
      wrap.appendChild(lab); wrap.appendChild(input); wrap.appendChild(err);
      parent.appendChild(wrap);
      return { el: input, err };
    }

    /* Optional multi-line field (allergies/notes). Same label/error contract
       as textField; maxlength mirrors the server's 500-char cap. */
    textareaField(parent, id, label, placeholder) {
      const wrap = el("div", "wc-field");
      const lab = el("label", "wc-label", label);
      lab.setAttribute("for", id);
      const input = el("textarea", "wc-input wc-textarea");
      input.id = id; input.placeholder = placeholder;
      input.rows = 2; input.maxLength = 500;
      input.setAttribute("autocomplete", "off");
      const err = el("div", "wc-error");
      input.setAttribute("aria-describedby", id + "-err");
      err.id = id + "-err";
      wrap.appendChild(lab); wrap.appendChild(input); wrap.appendChild(err);
      parent.appendChild(wrap);
      return { el: input, err };
    }

    /* ---- submit ----------------------------------------------------------- */
    async submit(book) {
      const t = this.t;
      let ok = true;
      const setErr = (field, msg) => {
        field.err.textContent = msg || "";
        field.err.classList.toggle("show", !!msg);
        field.el.setAttribute("aria-invalid", msg ? "true" : "false");
        if (msg && ok) { field.el.focus(); ok = false; }
      };
      const name = this.nameInput.el.value.trim();
      const email = this.emailInput.el.value.trim();
      setErr(this.nameInput, name ? "" : t.err_name);
      setErr(this.emailInput, EMAIL_RE.test(email) ? "" : t.err_email);
      if (!ok) return;

      book.disabled = true;
      const original = book.textContent;
      book.textContent = t.redirecting;
      this.announce(t.redirecting);

      const payload = {
        route_id: this.routeId, date: this.selectedDate, slot: this.selectedSlot.slot,
        party: this.party, name, email, phone: this.phoneInput.el.value.trim(),
        notes: this.notesInput ? this.notesInput.el.value.trim() : "",
        locale: this.lang, marketing_opt_in: !!this.optIn.checked,
      };
      try {
        const res = await this._fetch(`${this.api}/api/book`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.checkout_url) {
          window.location.href = data.checkout_url; // hand off to Stripe
          return;
        }
        if (res.status === 409 && data.error === "sold_out") {
          book.disabled = false; book.textContent = original;
          this.announce(t.err_soldout);
          // refresh the day's slots so the numbers are honest again
          try { const s = await this.loadSlots(this.selectedDate); this.slots = s.closed ? [] : (s.slots || []); this.selectedSlot = null; this.renderSlots(); } catch (e) { /* noop */ }
          this.flashError(t.err_soldout);
          return;
        }
        throw new Error(data.error || "book_failed");
      } catch (e) {
        book.disabled = false; book.textContent = original;
        this.flashError(t.err_book);
        this.announce(t.err_book);
      }
    }

    flashError(msg) {
      // reuse email field's error line as a general banner if the form is present
      let banner = this.card.querySelector(".wc-book-error");
      if (!banner && this.formHost) {
        banner = el("div", "wc-error wc-book-error show");
        banner.setAttribute("role", "alert");
        const book = this.formHost.querySelector(".wc-book");
        if (book) book.parentNode.insertBefore(banner, book);
      }
      if (banner) { banner.textContent = msg; banner.classList.add("show"); }
    }

    /* ---- a11y: announce + Escape ------------------------------------------ */
    announce(msg) { if (this.status) this.status.textContent = msg; }
  }

  /* ---- Escape closes the open detail panel, returns focus to the day ------ */
  function wireKeyboard(inst) {
    inst.mount.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (inst.formHost && inst.formHost.firstChild) {
        inst.formHost.innerHTML = "";
        inst.slotHost.querySelectorAll('.wc-slot[aria-pressed]').forEach((b) => b.setAttribute("aria-pressed", "false"));
        inst.setStep(1);
        if (inst._dayCell) inst._dayCell.focus();
      } else if (inst.slotHost && inst.slotHost.firstChild) {
        inst.slotHost.innerHTML = "";
        inst.setStep(0);
        if (inst._dayCell) { inst._dayCell.setAttribute("aria-pressed", "false"); inst._dayCell.focus(); }
      }
    });
  }

  /* ---- CTA re-aim (ACTIVE pages only) -------------------------------------
     When the calendar is live on a page, the page's existing booking CTAs
     (the #book section's "Book your walk" button, the sticky mobile book
     bar, and the nav CTA — all of which point at the old Wix
     /booking-calendar/ URL) should bring the guest HERE instead of leaving
     the site. One page: land → tap Book → you're at the calendar.

     This is ONLY called from autoInit() *after* the WOGO_API dormancy guard
     (or explicitly by a host shell like the preview) — a dormant widget
     never reaches this code, so Wix buttons stay untouched while the
     switch is off. Scoped to Wix booking-calendar links plus the sticky
     bar button; gift-card / group links are never matched. Idempotent
     (data-wc-retarget) and defensive: if selectors miss, nothing happens. */
  function retargetCtas(mountNode) {
    try {
      if (!mountNode || !document.contains(mountNode)) return;
      // Stable scroll target: first active calendar claims id="wogo-book".
      let anchor = document.getElementById("wogo-book");
      if (!anchor) { mountNode.id = "wogo-book"; anchor = mountNode; }
      // Focusable (not tabbable) so keyboard/AT users land where they scrolled.
      if (!mountNode.hasAttribute("tabindex")) mountNode.setAttribute("tabindex", "-1");

      const ctas = document.querySelectorAll('a[href*="booking-calendar"], .w-sticky-cta-btn');
      ctas.forEach((a) => {
        if (a.getAttribute("data-wc-retarget")) return; // idempotent
        a.setAttribute("data-wc-retarget", "1");
        a.setAttribute("href", "#wogo-book"); // real anchor → still works if JS below fails
        a.removeAttribute("target");
        a.addEventListener("click", (e) => {
          e.preventDefault();
          // If the mobile nav menu is open, close it so it doesn't cover the page.
          const burger = document.querySelector(".w-nav-burger.open");
          if (burger) burger.click();
          const reduce = window.matchMedia &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          anchor.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
          try { mountNode.focus({ preventScroll: true }); } catch (err) { mountNode.focus(); }
        });
      });
    } catch (e) { /* a CTA rewrite must never break the page */ }
  }

  /* ---- public API + auto-init -------------------------------------------- */
  function mount(node, opts) {
    const inst = new WogoCalendar(node, opts);
    wireKeyboard(inst);
    inst.init();
    return inst;
  }

  function autoInit() {
    if (!WOGO_API) return; // DORMANT — do not touch the page (Wix button stays)
    let first = null;
    document.querySelectorAll(".wogo-calendar").forEach((node) => {
      if (!first) first = node;
      if (node.getAttribute("data-wc-ready")) return;
      node.setAttribute("data-wc-ready", "1");
      mount(node);
    });
    if (first) retargetCtas(first); // ACTIVE + mount exists ⇒ Book buttons aim here
  }

  // Exposed so the preview shell (and any future host) can drive the REAL
  // widget with an injected fetch, while production uses the WOGO_API switch.
  window.WogoCalendar = { mount, autoInit, retargetCtas, WogoCalendar };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit);
  } else {
    autoInit();
  }
})();
