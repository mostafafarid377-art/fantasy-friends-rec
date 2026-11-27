# FantasyFriends security patch: setup

## Apply it
```
git checkout -b security-hardening
git apply fantasy-friends-security.patch
npm install        # lockfile changed
npm test           # 46 files, 346 tests pass
```

## Do these once (the code can't do them for you)
1. **Run the new migration** `supabase/migrations/0040_rate_limits.sql` the same way you run your others.
2. **Server env vars (Vercel):**
   - `GOOGLE_OAUTH_APP_ORIGIN` = your exact production URL (https, no trailing path). Emailed links now use it.
   - `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) must be set. Rate limits and the MFA flag need it. Without it, limits fall back to per-instance memory.
3. **Captcha:** Supabase dashboard > Authentication > Attack Protection > turn on CAPTCHA (Cloudflare Turnstile) and add the secret. Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. Once the site key is set, login, signup and reset reject requests without a token.
4. **MFA:** make sure TOTP is enabled in Supabase Authentication settings (on by default for new projects).
5. **Redirect URLs:** Supabase > Authentication > URL Configuration. List your exact production URLs. No wildcards.

## If someone loses their authenticator app
There are no recovery codes, so you must reset the account by hand in the Supabase SQL editor:
```sql
delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'person@example.com');
update auth.users set raw_app_meta_data = raw_app_meta_data - 'mfa_enrolled' where email = 'person@example.com';
```

## What was NOT changed
- **CSP still allows `'unsafe-inline'` scripts.** A nonce-based CSP needs every page to render per request, which would make the homepage dynamic (your proxy deliberately keeps it static). It also needs testing in a real browser.
- **MFA protects the app's own pages and API.** Someone with a stolen password could still call Supabase's REST API directly at password-only level. Closing that needs a restrictive RLS policy on aal2 for each table.
