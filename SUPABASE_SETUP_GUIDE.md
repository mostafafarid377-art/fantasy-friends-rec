# Fantasy Friends — Supabase Setup Guide

This guide walks you through creating a new empty Supabase project and configuring the Fantasy Friends application to connect to it.

## Prerequisites

- A Supabase account (https://supabase.com)
- Node.js 20+ installed
- The Fantasy Friends source code extracted

## Step 1: Create a New Empty Supabase Project

1. Log in to your Supabase dashboard
2. Click "New Project"
3. Choose your organization
4. Enter project name (e.g., "fantasy-friends")
5. Choose a region close to your users
6. Set a strong database password — **save this securely**
7. Click "Create new project"
8. Wait for the project to be provisioned (typically 1-2 minutes)

## Step 2: Get Your Project Credentials

1. In the Supabase dashboard, go to **Settings → API**
2. Copy the following values:
   - **Project URL** (e.g., `https://xxx.supabase.co`)
   - **Project API Key** (the `anon public` key, starts with `eyJ...`)
   - **Service Role Key** (the `service_role` secret key, starts with `eyJ...`)

## Step 3: Configure Environment Variables

1. Copy the example file:
   ```bash
   cp .env.example .env.local
   ```

2. Edit `.env.local` with your project credentials:
   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
   ```

   **Important:**
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are safe to expose in the browser
   - The `service_role` key must NEVER be exposed in browser code or committed to version control
   - `.env.local` is gitignored and must not be committed

## Step 4: Apply Database Migrations

Apply the migrations in order using the Supabase SQL Editor or the Supabase CLI:

```bash
# Using Supabase CLI (recommended)
supabase db push

# Or manually via SQL Editor in the dashboard, in this order:
# 1. supabase/migrations/0001_schema.sql
# 2. supabase/migrations/0002_rls.sql
# 3. supabase/migrations/0003_functions.sql
# 4. supabase/migrations/0004_native_auth_profiles.sql
```

**Important:** Do NOT run `supabase/legacy/0000_destructive_removal.sql` — it drops all application data.

## Step 5: Install Dependencies

```bash
npm.cmd ci
```

Or on non-Windows:
```bash
npm ci
```

## Step 6: Start the Application

```bash
npm.cmd run dev
```

Or on non-Windows:
```bash
npm run dev
```

The application will be available at `http://localhost:3000`.

## Step 7: Verify the Setup

1. Open `http://localhost:3000/health` — should return a healthy status
2. Open `http://localhost:3000/api/supabase/health` — should confirm Auth and database connectivity
3. Create a league via the UI
4. Create a match, submit a result, and approve it
5. Verify points and standings are calculated

## Environment Variable Reference

| Variable | Required | Exposure | Description |
|----------|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Browser-safe | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Browser-safe | Supabase anon (public) key |
| `SUPABASE_SERVICE_ROLE_KEY` | No | Server-only | Service role key (admin operations only) |

## Security Notes

- Never commit `.env.local` to version control
- Never expose the `service_role` key in browser bundles
- The application uses `createServerClient` with the anon key for all server-side data access — RLS policies enforce authorization at the database level
- All privileged match transitions go through SECURITY DEFINER RPC functions with explicit authorization checks
