// src/brevo.js — Brevo transactional email, plain fetch, zero-dependency.
//
// Supports two shapes:
//   * OWNED HTML (Dashboard v2, preferred): { to, subject, htmlContent, sender?, replyTo? }
//     — the Worker renders the branded HTML itself (src/emails.js), so no Brevo
//     dashboard templates need to be built or maintained.
//   * Brevo-hosted template (legacy):       { to, templateId, params }
//
// Whichever is passed, this just POSTs it to Brevo's transactional endpoint.

import { EMAIL_SENDER } from './config.js';

export async function sendTransactional(env, msg) {
  // TEST-SAFETY: if EMAIL_TEST_REDIRECT is set (a Worker secret used pre-go-live),
  // every recipient is rewritten to that address and the real recipient is shown
  // in the subject, so test bookings can never reach real inboxes/bars/Wix filters.
  // Remove the secret at go-live and real addresses are used again. Keeps prod
  // config (info@…) correct so the test suite stays green.
  const redirect = env && env.EMAIL_TEST_REDIRECT;
  const realTo = msg.to;
  const to = redirect || realTo;

  const payload = { to: [{ email: to }] };

  if (msg.htmlContent) {
    payload.sender = msg.sender || EMAIL_SENDER;
    payload.subject = redirect ? `[TEST → ${realTo}] ${msg.subject}` : msg.subject;
    payload.htmlContent = msg.htmlContent;
    if (msg.replyTo) payload.replyTo = msg.replyTo;
  } else {
    payload.templateId = msg.templateId;
    payload.params = msg.params;
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`brevo_send_failed: ${res.status} ${await res.text()}`);
}
