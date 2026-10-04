# Security notes

## Production boundary

GitHub Pages serves only static assets. Supabase Auth verifies emailed sign-in
links or codes, Row Level Security protects the owner's cloud snapshot, and an
authenticated Edge Function is the only component that receives product photos or
can read the OpenAI key.

Secrets are stored only in Supabase's encrypted Edge Function environment. The
browser keeps the Supabase session in its protected same-origin browser storage
and makes authenticated cross-origin requests to this project's Supabase URL.
Authenticated API responses and synchronization data are never service-worker cached.

## Controls implemented

- One allow-listed email stored outside the repository as a one-way database hash
  and an encrypted Edge Function secret.
- Expiring Supabase email authentication and signed sessions.
- Owner-only RLS policies plus exact production-origin checks.
- Fixed OpenAI model, prompt, low-detail image mode, and structured output schema.
- Image MIME/signature/size validation and no image persistence.
- Ten scans per UTC day and a conservative estimated £2 monthly ceiling.
- Supabase synchronization with optimistic revision conflicts and owner-only rows.
- Final synchronization before logout; the locked offline cache is retained to
  prevent an in-flight edit from being deleted.
- Restrictive Content Security Policy and no-referrer policy in the static page.
- No arbitrary proxy destinations in settings or restored backups.
- Tesco links opened with `noopener,noreferrer`; no Tesco credential collection.

## Operational requirements

Keep the OpenAI and allow-list values in Supabase encrypted secrets, keep new-user
creation disabled in both Supabase Auth and the browser, retain exact production origins, and configure a
provider-side OpenAI budget alert as a second layer behind the in-app cap. Re-run
Supabase security/performance advisors and the mobile-camera checks after database
or function changes.

Never publish `.env`, `server/data/`, an API key, an authentication code, or the
private allow-listed email in the repository.

## Deployment verification (2026-10-04)

The production project was provisioned through its dashboard. Schema setup was
applied as a creation-only equivalent of the committed migrations; migration
history was not imported. Reconcile that history before future CLI migration pushes.
The dashboard-created automatic-RLS helper was separately hardened with
`supabase/dashboard-hardening.sql` and both browser roles were verified to lack
execution permission. Anonymous pantry reads, quota RPCs and photo requests
returned HTTP 401. The password-leak protection advisory remains a documented
limitation; the app exposes email-link sign-in, not password sign-in.

The Pages workflow uploads an explicit public-assets directory. Server source,
database scripts, tests and environment files are excluded from the website.
