# Launch summary — read this before MIGRATION-PLAYBOOK.md

**Target launch: Monday 14 Sep 2026, ~09:00** (Monday morning beats Sunday: Sunday evening is a booking moment; Mon–Wed are quiet days to fix things before the Thu–Sat peak). Earlier only if all five locks below are open.

## Five locks — all must be open to launch
1. **Guest can pay and land on a "you're booked" page.** `/booking-confirmed/` doesn't exist yet (Stripe success_url points there). Build first.
2. **Money is real.** Stripe live keys + live webhook secret set; `EMAIL_TEST_REDIRECT` secret deleted; confirmation email reaches Gmail/iCloud/Outlook inbox (SPF/DKIM/DMARC for Brevo).
3. **Nothing points into the void.** `/delft/` + `/delft/book/` built (Delft ads are live); `/nl/` for the ad cities (or written waiver); full redirect list (playbook §5.4) loaded in Cloudflare; all `noindex` removed, canonicals self-referencing.
4. **Ads can still see sales.** GTM + GA4 + Meta pixel on every page behind the consent banner; Worker CAPI with a real token on the pixel the ad sets optimise on (…94, not …692); browser/server dedupe verified in Events Manager.
5. **Nobody gets stranded.** Future Wix bookings imported as manual bookings in admin; unredeemed Wix gift cards recreated as Stripe promo codes.

## Owner tasks this week (~2 h)
- Ads Manager: write down the website link of all ~31 ads → `LAUNCH-URL-INVENTORY.md`.
- Export 12 months of Wix bookings/revenue + GA4 + Search Console + Ads Manager (playbook §10).
- Decide: Schiedam walk and Amsterdam Route 2 Premium still sold? (redirect targets)
- Check domain registrar (Wix → Domains). If via Wix, transfer before ever cancelling Wix.
- Confirm the full pixel ID ending in 94 in Events Manager.

## Safety net
- Wix stays paid + domain-connected 30 days after launch; DNS rollback ≈ 10 min (Cloudflare, TTL 60 s).
- `BOOKING_FALLBACK_URL` flag: all Book buttons → old Wix calendar in 5 min if the engine misbehaves.
- Launch test: one real €29,95 booking within 30 min of the flip → payment, admin row, guest email, bar email, Meta Purchase, GA4 purchase. All six or we switch back.
- Hard rule: bookings < 50% of baseline at 24 h with no known cause → full rollback before Thursday.

Files: `MIGRATION-PLAYBOOK.md` (full plan, 16 sections) · `OLD-URLS.txt` (226 old Wix URLs) · `REDIRECT-MAP.md` (superseded by playbook §5.4).
