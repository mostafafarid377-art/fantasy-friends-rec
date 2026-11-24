# Custom SMTP for Auth Emails — provider-neutral setup guide

## Why this is required before launch

Supabase's built-in email sender is a **shared, demo-grade service: ~2–4
emails per hour per project**, with no deliverability guarantees. Signup
confirmations, password resets and resends all draw from that tiny budget.
The first real evening with a handful of signups will exhaust it and
registration silently stalls. **Custom SMTP removes the cap** (your
provider's limits apply instead) and lands emails in inboxes instead of
spam.

This is a dashboard-only change: no code, no redeploy, no migration.

## What you need

Any SMTP-capable provider account. Common free/cheap tiers that work fine
at this app's volume:

| Provider | Free tier | Notes |
|---|---|---|
| Resend | ~100/day | Clean API + SMTP; good docs |
| Brevo | ~300/day | SMTP only; generous cap |
| Mailgun | trial ~100/day | EU/US regions |
| Amazon SES | 62k/mo from EC2, else ~$0.10/1000 | Cheapest at scale, more setup |
| Postmark | 100/mo trial | Excellent deliverability |

Pick one; the steps below are identical for all of them.

## Steps

1. **Create the sender identity** in your provider: verify the sending
   domain (e.g. `mail.fantasyfriends...` or the provider's shared domain to
   start). Domain verification means adding the provider's SPF/DKIM records
   at your DNS host — without them, expect spam-folder delivery.
2. **Create SMTP credentials** in the provider dashboard: it shows
   - Host (e.g. `smtp.resend.com`)
   - Port (`465` SSL or `587` STARTTLS — either is fine)
   - Username (often `resend` / your account id)
   - Password (an API key — treat it like a secret)
3. **Enter them in Supabase**: Project → Authentication → **Emails** →
   SMTP Settings → enable **Custom SMTP** and fill host, port, username,
   password, and the **sender address** you verified in step 1
   (`Fantasy Friends <no-reply@your-domain>`).
4. **Save and send a test email**: Authentication → Users → Invite user
   (to an address you own), or simply run the app's **Forgot password**
   flow against your own account.
5. **Verify the full loop**: the email arrives (check spam on the first
   one), the link opens `https://<your-domain>/auth/callback?...`, and the
   session is established. Then confirm the Supabase **Auth logs** show a
   successful send.

## Rollback

Disable **Custom SMTP** in the same dashboard panel. The project falls back
to the built-in ~2/hr sender immediately — fine as an emergency measure,
not as a steady state.

## Notes specific to this app

- Email templates live in Authentication → Emails → Templates. The app's
  links are already correct (`/auth/callback` handles confirmation and
  recovery); do not change `{{ .ConfirmationURL }}` or the `next` parameter.
- The **resend verification** endpoint is rate-limited (5/hour per account)
  by the app itself since migration 0034 — SMTP volume from abuse stays low.
- Keep the SMTP password out of the repo and out of Vercel env vars; it
  belongs only in the Supabase dashboard.
