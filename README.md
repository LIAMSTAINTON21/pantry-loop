# Pantry Loop

Pantry Loop is an offline-friendly personal grocery tracker with barcode scanning,
product-label recognition, a persistent shopping list, and a guided Tesco handoff.

## Hosted phone app

The production app is hosted on GitHub Pages and uses Supabase for passwordless
email sign-in, owner-only cloud synchronization, and the protected product-photo
function. The OpenAI key and approved email are encrypted Supabase function
secrets; only the public Supabase URL and publishable browser key are shipped.

Supabase Row Level Security checks both the signed-in user ID and an allow-listed
email hash before any pantry snapshot can be read or changed. New-user creation is
disabled both in Supabase Auth settings and in the browser client after the single
owner account is provisioned. The free built-in mail service sends a one-time
sign-in **link**, not a numeric code. Open the link in the browser you want to use.
The approved owner is also an organization member, as required by the built-in
mail service; custom SMTP is needed for general-purpose email delivery or a
custom numeric-code template.

For optional loopback-only development, set the local server values and run:

```powershell
$env:ALLOWED_EMAIL = "your-private-email@example.com"
$env:OPENAI_API_KEY = "your-openai-api-key"
npm start
```

Open `http://127.0.0.1:8080/`. This legacy development server binds only to the
loopback interface and is not used by the published phone app.

The API key is optional for authentication and synchronization. Without it, photo
recognition returns a configuration error and the app retains the barcode before
showing the manual form.

## AI limits

The Supabase Edge Function uses the pinned `gpt-4o-mini-2024-07-18` model with low-detail image
input, accepts only JPEG, PNG, or WebP product
images, and supplies its own prompt and JSON schema. Client prompts and model names
are ignored. It permits at most 10 accepted scan attempts per UTC day and applies
a conservative estimated £2 monthly ceiling. Usage accounting is private in
Supabase and cannot be read or changed by the browser.

The application ceiling is a safety backstop, not a provider billing guarantee.
Set a separate project budget/alert in the OpenAI Platform as a second layer of
protection; the local ceiling cannot guarantee or control provider billing.

## Tesco handoff

The shopping-list screen offers both:

- copying the complete list; and
- opening each item as an official Tesco search, one at a time.

Both actions show a warning first. Local progress marks can be undone or reset, but
an item added to Tesco's website must be removed from the Tesco basket there. The
app never stores Tesco credentials or automates Tesco's private basket APIs.

## Data and privacy

Browser data is stored in IndexedDB and synchronized to the owner's Supabase row after
sign-in. Logout performs a final authenticated sync and locks the UI. The offline
device cache is retained so an edit racing the final network request cannot be
deleted; it remains inaccessible through the app until the owner signs in again.
The cloud snapshot remains available for the next sign-in. JSON backups remain the portable,
restorable format. Legacy custom proxy addresses are removed during backup import
and synchronization so a backup cannot redirect photos or barcodes.

Product photos are re-encoded and resized in the browser, uploaded only after the
user deliberately captures one, and are not persisted by the Edge Function.

## Commands

```powershell
npm test
npm start
```

The browser uses a pinned, locally served Supabase client bundle; there is no
production build step. `server/data/`, `.env`, and other `.env.*` files are ignored.
Do not add secrets to source files, browser
settings, GitHub variables intended for client code, or backups.

## Physical acceptance checks still required

- Verify camera permission and barcode scanning on the intended phone release.
- Photograph representative products and review name, brand, variant, and size.
- Confirm the daily and monthly AI-limit messages.
- Test sign-out, repeat sign-in, and cross-device Supabase synchronization.
- Check Tesco searches, punctuation, quantities, skipped items, and local undo.
- Install and cold-open the final HTTPS release in airplane mode.
