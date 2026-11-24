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
   - `https://fantasy-friends-rec.vercel.app/auth/callback/google`
   - `http://localhost:3000/auth/callback/google` (only for local development)

   Keep existing email confirmation and password recovery redirects, including
   `/auth/callback?next=/dashboard` and `/auth/callback?next=/reset`. No new
   wildcard is needed. Use a stable, exact preview domain if testing a preview.
2. In the app deployment, set the server-only `GOOGLE_OAUTH_APP_ORIGIN` to that
   deployment’s exact browser origin (e.g. `https://fantasy-friends-rec.vercel.app` or
   `http://localhost:3000` in `.env.local`). No path, query or hash. Use HTTPS
   except for local development. Leave the existing
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in place.
   On a Vercel production deployment (`VERCEL_ENV=production`), the app also
   recognizes the pinned production hosts `fantasyfriends.vercel.app` (canonical)
   and `fantasy-friends-rec.vercel.app` (legacy, kept for redirects/rollback)
   once Google is opted in. Preview and local deployments accept only the
   configured origin.
   Redirect other aliases to the canonical hostname. Forwarded host headers
   cannot add a callback URL.
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

## Troubleshooting the initiation request

1. Open `https://fantasy-friends-rec.vercel.app/login?next=%2Fteam` directly in
   a browser tab and enable **Preserve log** in DevTools → Network.
2. Click **Continue with Google**. The browser submits a regular URL-encoded
   `POST /api/auth/google`. The form includes a random token that must match a
   host-only, HttpOnly cookie issued on the sign-in page. A browser may omit
   `Origin` and Fetch Metadata; an explicitly foreign origin, an unrecognized
   host, or a missing/mismatched token cannot start PKCE. If the app returns to
   sign-in, reload the page in a top-level browser tab with first-party cookies
   enabled. Do not share the form token or cookie values.
3. Expect a **303** to Supabase `/auth/v1/authorize`, then Google's chooser.
   The `redirect_to` parameter should be exactly
   `https://fantasy-friends-rec.vercel.app/auth/callback/google`. In the initiation
   response, the `ff-google-flow` cookie should have path `/auth/callback/google`;
   the Supabase PKCE verifier cookies have path `/`. Both are host-only,
   `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS. Do not share their values
   or the OAuth code when reporting a failure.
4. Finish Google sign-in and check that `/auth/callback/google` returns a **303**
   to `/team`. Refresh, confirm the session persists, then sign out and confirm
   password sign-in still works. Repeat locally using `http://localhost:3000`
   and the matching env setting and allowlist entry. HTTP localhost cookies
   intentionally omit `Secure`.
