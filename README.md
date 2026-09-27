# Pantry Loop

An offline-first personal grocery tracker. Scan purchases, scan finished packs,
and keep a persistent weekly shopping list on one phone. The core app has no
account and keeps shopping history on the device.

## Run locally

Serve this directory from localhost (opening `index.html` directly will not give
the service worker or camera a secure origin). For example:

```powershell
python -m http.server 8080
```

Open `http://localhost:8080/`. A phone accessing a laptop's ordinary LAN HTTP
address will not receive camera access; publish to HTTPS for phone testing.

## Test

```powershell
npm test
```

The application itself has no build step and no production install. The included
GitHub Pages workflow publishes this folder as-is when it is the repository root.
In repository Settings, choose **GitHub Actions** as the Pages source, then push
`main`. The manifest and worker use project-relative URLs so repository subpaths
work.

## Data and privacy

Shopping data stays in IndexedDB in the browser. If Online product details is on,
an eligible retail barcode is sent to the configured Tesco proxy, or to Open Food
Facts when no proxy is configured. Photos are resized in the browser and uploaded
only after the user deliberately chooses **Take photo** and a Vision proxy is
configured. API secrets must stay on that proxy; never put them in this public app.
Use Settings → Download JSON backup regularly; JSON is the authoritative restore
format and Excel is a readable snapshot.

## Tesco and Vision integrations

Settings accepts two HTTPS server endpoints. The Tesco endpoint receives
`{"barcode":"...","retailer":"tesco-gb"}` and returns either HTTP 404 or a
product object containing `name`/`product_name`, `brand`, `price`, `currency`,
`image_url`, `category`, and `quantity`/`size`. The Vision endpoint receives a
compressed JPEG data URL plus a prompt and JSON schema, and returns those same
normalized product fields. These endpoints are intentionally server-side hooks:
Tesco/Pepesto and multimodal API keys must not be shipped to GitHub Pages.

## Physical acceptance checks still required

- Install and cold-open from the real GitHub Pages subpath in airplane mode.
- Scan native and forced-fallback barcodes on the Pixel 8 Pro.
- Hold one code for 10 seconds, then remove/re-present it.
- Measure 10 packs under 40 seconds and 30 readable packs under 2 minutes.
- Verify downloads and the generated workbook in the phone's normal apps.
- Exercise an app update during idle time and confirm existing data is retained.
