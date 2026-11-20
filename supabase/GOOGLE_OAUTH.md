# Enable Google sign-in for Fantasy Friends

The implementation uses the existing **Hagz-fantasy** project
(`zkrfgdiujpagaddsxbcb`), the same Supabase session cookies as email/password,
and the existing Auth-to-profile trigger. There is no new database migration,
service-role key, Google client-side library, or Google refresh-token setup.

## 1. Google Cloud Console

1. Configure the OAuth consent screen in Google Auth Platform. Set the app name
   and support contact. If the app is in **Testing**, add the people testing
   sign-in as test users; publish the app when ready for its intended audience.
2. Create an OAuth client of type **Web application**. Under **Authorized redirect
   URIs**, add the Supabase provider callback:
   `https://zkrfgdiujpagaddsxbcb.supabase.co/auth/v1/callback`
   (if the project uses a custom Auth domain, copy the callback shown in the
   Supabase Google provider settings instead). Do **not** put the Fantasy Friends
   callback here. This server redirect flow does not use Google One Tap and does
   not need a Google authorized JavaScript origin.
3. Copy the Client ID and Client Secret directly into **Supabase → Authentication
   → Sign In / Providers → Google**, and enable Google. Do not put the credentials
   in the Fantasy Friends repo, Vercel env, or any `NEXT_PUBLIC_` variable. Keep
   the existing email provider, signup and confirmation settings as intended.

## 2. Supabase redirect allowlist and deployment

1. In **Hagz-fantasy → Authentication → URL Configuration**, check that **Site
   URL** is the canonical production app URL. **Append** an exact Redirect URL
   for each environment where Google sign-in is enabled, for example:
   - `https://YOUR-PRODUCTION-DOMAIN/auth/callback/google`
   - `http://localhost:3000/auth/callback/google` (only for local development)

   Keep existing email confirmation and password recovery redirects, including
   `/auth/callback?next=/dashboard` and `/auth/callback?next=/reset`. No new
   wildcard is needed. Use a stable, exact preview domain if testing a preview.
2. In the app deployment, set the server-only `GOOGLE_OAUTH_APP_ORIGIN` to that
   deployment’s exact browser origin (e.g. `https://YOUR-PRODUCTION-DOMAIN` or
   `http://localhost:3000` in `.env.local`). No path, query or hash. Use HTTPS
   except for local development. Leave the existing
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in place.
   If the deployment has multiple hostnames, redirect aliases to the canonical
   hostname; Google start requests from other origins are intentionally rejected.
3. Deploy/restart the app. If `GOOGLE_OAUTH_APP_ORIGIN` is unset, the Google
   option is hidden and password auth remains available. Enable the env setting
   only after Google and the redirect allowlist are configured. To pause Google
   sign-in in the app, remove the setting and redeploy.

## 3. Live smoke check

Use a top-level browser tab, not an embedded preview. Complete the flow within
10 minutes in the same browser that started it (a new attempt replaces a pending
attempt in that browser).

- On **Sign in** and **Create account**, confirm **Continue with Google** opens
  Google’s account chooser and returns to the app. Test a first-time account,
  then refresh a protected page, sign out, and sign in again. Verify the same
  account/profile is reused. New users receive the existing generated profile
  defaults and can edit them on the Profile page.
- With a test email/password account whose email is verified and also belongs to
  the selected Google account, verify Supabase’s automatic verified-email
  identity linking preserves the original user ID, profile and league
  memberships. The app never merges accounts based on a client-supplied email.
- Cancel consent and verify the retry message and email sign-in alternative.
  Check Google sign-in from `/login?next=%2Fteam` returns to `/team`.
- Verify existing password sign-in, sign-up confirmation, password reset and
  sign-out. Verify signed-out requests still cannot open protected pages.
