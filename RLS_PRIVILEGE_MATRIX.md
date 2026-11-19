# Fantasy Friends — RLS and SQL privilege matrix

This matrix describes the local Phase 2 migrations after the remediation pass. It is a source review, not evidence from a PostgreSQL execution.

All 26 application tables in `0001_schema.sql` have RLS enabled by `0002_rls.sql`. RLS is not forced. The migrations rely on explicit authorization inside the `SECURITY DEFINER` RPCs, which execute as their owner; the owner-context functions therefore require their own authorization checks. `anon` receives no application-table grants. `authenticated` receives only the listed table privileges, with RLS still filtering rows.

| Table | RLS | SELECT policy | INSERT policy | UPDATE policy | DELETE policy | `authenticated` SQL grants |
|---|---|---|---|---|---|---|
| `profiles` | Enabled | Self and shared-league profiles | Own profile only (no direct grant) | Own profile only | None | SELECT, UPDATE(`username`, `display_name`, `avatar_url`, `bio`) |
| `sessions` | Enabled | Own row via ALL policy | Own row via ALL policy | Own row via ALL policy | Own row via ALL policy | None; server-only |
| `auth_tokens` | Enabled | Own row via ALL policy | Own row via ALL policy | Own row via ALL policy | Own row via ALL policy | None; server-only |
| `mail_outbox` | Enabled | Own email address | None | None | None | SELECT |
| `leagues` | Enabled | Members or creator | Creator identity | League Leader | Creator | SELECT, INSERT, DELETE, UPDATE on editable metadata/config columns only |
| `league_members` | Enabled | Own row or league members | Own identity and creator/leader gate | Leader policy; direct grant limited to `team_name` | Self or Leader | SELECT, INSERT, DELETE, UPDATE(`team_name`) |
| `invitations` | Enabled | Members or creator | Leader via manage policy | Leader via manage policy | Leader via manage policy | SELECT, INSERT, DELETE, UPDATE on invitation fields only |
| `teams` | Enabled | League members | Leader | Leader | Leader | SELECT, INSERT, DELETE, UPDATE(`name`, `short_name`, `crest_url`) |
| `players` | Enabled | League members | Leader and creator identity | Leader and creator identity | Leader | SELECT, INSERT, DELETE, UPDATE on player detail fields only; league/creator identity immutable |
| `fantasy_squads` | Enabled | League members | Own profile and member | Own profile | Own profile | SELECT, INSERT, DELETE, UPDATE on formation/captain/vice-captain/completion fields only |
| `fantasy_squad_players` | Enabled | Own squad via ALL policy | Own squad via ALL policy | Own squad via ALL policy | Own squad via ALL policy | SELECT, INSERT, DELETE, UPDATE(`slot`, `order`) |
| `fantasy_fixtures` | Enabled | League members | Leader and creator identity | Leader | Leader | SELECT, INSERT, DELETE, UPDATE on fixture detail fields only |
| `real_matches` | Enabled | League members | Organizer role and self as organizer | RPC-only for state changes; policy remains but no direct UPDATE grant | Leader, only before approval | SELECT, INSERT, DELETE |
| `match_lineups` | Enabled | League members | Match Organizer while editable | Match Organizer while editable | Match Organizer while editable | SELECT, INSERT, DELETE, UPDATE(`team_id`, `player_id`, `slot`, `order`) |
| `match_events` | Enabled | League members | Match Organizer while editable and self as creator | Match Organizer while editable | Match Organizer while editable | SELECT, INSERT, DELETE, UPDATE on event detail fields only |
| `match_substitutions` | Enabled | League members | Match Organizer while editable and self as creator | Match Organizer while editable | Match Organizer while editable | SELECT, INSERT, DELETE, UPDATE on substitution detail fields only |
| `match_approvals` | Enabled | League members | Organizer submit / Leader decision policy | None | None | SELECT only; writes through state-machine RPCs |
| `scoring_rules` | Enabled | League members | League Leader | League Leader; approved rules must name the current Leader as approver | League Leader | SELECT, INSERT, DELETE, UPDATE on points/approval fields only |
| `player_match_points` | Enabled | League members | Explicitly denied | None | None | SELECT only |
| `manager_points` | Enabled | League members | Explicitly denied | None | None | SELECT only |
| `league_standings` | Enabled | League members | Explicitly denied | Explicitly denied | None | SELECT only |
| `fantasy_points_history` | Enabled | League members | Explicitly denied | None | None | SELECT only |
| `notifications` | Enabled | Owner only | None | Owner only (`read_at` only) | Owner only | SELECT, UPDATE(`read_at`), DELETE |
| `league_activity` | Enabled | League members | Member acting as self (`profile_id`) policy; direct insert grant withheld | None | None | SELECT only; trusted RPCs insert activity |
| `audit_logs` | Enabled | Own global logs or Leader for league logs | None | None | None | SELECT |
| `mutation_ops` | Enabled | Own profile only | None for direct clients | None for direct clients | None for direct clients | SELECT only; writes must move behind idempotent server/RPC operations |

## Important interpretation

- RLS policy presence does not grant SQL privileges. The migration now explicitly revokes application-table privileges from `PUBLIC`, `anon`, and `authenticated`, then grants the minimum direct table operations listed above.
- Points, standings, and approval-history writes are intentionally not directly granted to `authenticated`; the guarded RPCs perform those writes as their owner.
- `real_matches` direct UPDATE is intentionally not granted. Status, submission, approval, and rejection transitions must go through `submit_match`, `approve_match`, and `reject_match`.
- `league_activity` and `mutation_ops` direct client writes are withheld. The future Supabase data layer must write these through trusted server/RPC paths; idempotency RPC implementation remains a deployment blocker.
- `sessions` and `auth_tokens` have own-row policies but no direct client grants because they are server-only credential/session data. `profiles` cannot be inserted or have Auth-owned email/password/verification fields updated directly; profile creation and email synchronization use Auth triggers.
- `anon` has no application-table grants. RLS is enabled on every app table; RLS is not forced because privileged owner-context functions are part of the design and must be protected by their own checks.
