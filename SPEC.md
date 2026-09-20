# Shopping List App — Build Spec

Audited revision: 20 September 2026.

A personal grocery tracker: scan items bought from Tesco, scan packs as they are
finished, and generate the next weekly shopping list.

Single user. One Google Pixel 8 Pro using Chrome or the installed PWA. No app
accounts, application backend, subscriptions, or paid APIs. GitHub serves the
static app; shopping history stays in the browser. Optional product lookups send
the barcode to an external product database.

This is an implementation specification. Phone performance and third-party
lookup coverage remain acceptance tests, not guarantees established by this audit.

---

## 1. Non-negotiable constraints

| Constraint | Requirement |
| --- | --- |
| Zero running cost | Use free static hosting and free lookup services within their limits. |
| No build step | Plain HTML/CSS/JS; no bundler, transpiler, or production npm install. |
| Works offline | After initial installation and caching, scanning, logging, list generation, editing, import, and export work offline. Unknown product names can be completed later. |
| Secure camera access | Use HTTPS on the phone; localhost is suitable for development on the device running the server. |
| Portable data | One Export menu offers a complete JSON backup and an Excel workbook, each as a separate download. |
| Low friction | Target 30 readable packs in under 2 minutes, with no taps between packs after camera permission and setup. Naming must not interrupt scanning. |

Low friction is the main design priority. Data must still be committed before
the app acknowledges a successful scan. The speed target includes repeated
products and is measured on the actual phone.

---

## 2. Stack and repository

- Frontend: vanilla HTML, CSS, ES modules.
- Storage: IndexedDB through a locally vendored browser-compatible `idb` build.
- Scanning: native `BarcodeDetector` where the required formats are supported;
  locally vendored `zxing-wasm` reader as fallback.
- Excel export: locally vendored SheetJS Community Edition browser build.
- Hosting: GitHub Pages, using a public repository for the GitHub Free route.
- PWA: manifest, local icons, and service worker.

Vendor all runtime dependencies under `vendor/`, including transitive browser
modules and the ZXing `.wasm` binary. Pin matching versions and record download
sources, versions, checksums, and licences in `vendor/README.md`. No runtime CDN
requests or unresolved npm-style imports are allowed.

ZXing's default WASM location can point to a CDN: explicitly configure
`prepareZXingModule` / `locateFile` for the local reader binary before first use.
Use a prebuilt browser distribution, such as the reader IIFE, rather than
assuming an npm entry point works directly in the browser.
[ZXing WASM documentation](https://github.com/Sec-ant/zxing-wasm).

Obtain SheetJS from its official distribution and retain the selected version
locally. [SheetJS browser installation](https://docs.sheetjs.com/docs/getting-started/installation/standalone/).

```text
index.html
app.css
manifest.webmanifest
sw.js
.nojekyll
package.json          contains "type": "module"; no build required
icons/                192px, 512px, and maskable icons
src/
  main.js             entry point and hash-based navigation
  db.js               schema, migrations, transactions, and event writes
  barcode.js          format validation and canonical product keys
  inventory.js        pure stock replay and correction logic
  scanner.js          camera lifecycle and continuous decoding
  lookup.js           optional metadata lookup and retry queue
  list.js             pure shopping-list rules
  export.js           JSON/Excel export and validated JSON restore
  views/
    scan.js
    catalogue.js
    list.js
    settings.js
vendor/               pinned browser libraries, WASM, and licences
test/
  list.test.mjs
  inventory.test.mjs
  barcode.test.mjs
  import.test.mjs
  fixtures.mjs
SPEC.md
```

Node is needed only for development tests: `node --test`. The phone runs the
checked-in static files without Node or npm.

---

## 3. HTTPS, deployment, and offline operation

Camera access requires a secure context. An ordinary LAN URL such as
`http://192.168.1.x:8080` is unsuitable: `navigator.mediaDevices` may be absent,
rather than a camera prompt appearing. Detect this and explain it in the UI.
On the phone, localhost means the phone, not the laptop.
[Camera requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

Deploy to `https://<owner>.github.io/<repository>/`. GitHub Pages supports this
static project layout; its free route uses a public repository. Keep personal
exports and real shopping histories out of the repository.
[GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).

Deployment requirements:

- Use project-relative paths such as `./app.css`, not `/app.css`. Resolve worker
  and WASM URLs relative to the app or module URL.
- Use hash routes so refreshing a tab does not need server-side routing.
- Set manifest `id`, `start_url`, and `scope` consistently for the project
  subdirectory. Register `./sw.js` with that same scope.
- Precache the complete app: views, libraries, export code, icons, and WASM.
  Show **Ready offline** only after the required cache is complete and an active
  service worker controls the app. A first-ever visit still requires internet.
- If caching fails, retain any working older cache and provide a retry. Never
  claim offline readiness after a partial installation.
- Use versioned caches specific to this app. Delete only this app's obsolete
  caches, never unrelated origin caches or IndexedDB data.
- Offer updates when scanning and database writes are idle. Do not force a
  reload during a scan, import, or export, or mix an old page with new assets.
- Force the WASM fallback during an airplane-mode test, even if native scanning
  works on the Pixel. A cached native-only path is not enough.

Ask for persistent browser storage where supported and display the result in
Settings. Persistence can be refused and does not replace backups; clearing
site data or losing the phone can still lose history.
[Persistent storage API](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist).

---

## 4. Data model and write integrity

Four IndexedDB object stores. All product keys and barcode values are strings.
Use an app-specific database name. Create indexes on each log's `barcode` and
`sessionId`, plus purchase `listId` for shopping-list reconciliation.

### `products` — key: `barcode`

| Field | Type | Meaning |
| --- | --- | --- |
| `barcode` | string | Canonical product key; see §6. |
| `barcodeFormat` | string | Recognised symbology, or `manual`. |
| `name` | string | Resolved name or `Unknown item · {code}`. |
| `brand`, `size`, `category` | string or null | User-editable metadata. |
| `userEditedFields` | string[] | Fields a remote response must never overwrite. |
| `lookup` | object | State (`pending`, `resolved`, `missing`, `manual`), source, checked time, next retry time; timestamps may be null. |
| `onHandQty` | non-negative integer or null | Derived estimate of unopened/in-use packs remaining; null means no stock history. |
| `status` | `unknown`, `in_stock`, or `finished` | Derived from effective stock events; never an independently edited flag. |
| `isStaple` | boolean | Include on the user's schedule. |
| `staplePeriodDays` | positive integer or null | Default 7 when enabled. |
| `defaultQty` | positive integer | Suggested purchase quantity; default 1. |
| `snoozeUntil` | `YYYY-MM-DD` or null | Suppress automatic suggestions before this date. |
| `neverSuggest` | boolean | Suppress all automatic list rules, including run-outs. |
| `createdAt` | UTC ISO datetime | Creation time. |

### `purchases` — key: `id`

One event per accepted purchase action. An initial stock entry is also stored
here with an explicit source so it cannot be mistaken for a purchase interval.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | UUID string | Generated once per action and reused if that write is retried. |
| `seq` | positive safe integer | Monotonic order shared by both event stores. |
| `barcode` | string | Existing product key. |
| `qty` | positive integer | Packs added; one per ordinary scan. |
| `purchasedAt` | UTC ISO datetime | Time of action. |
| `purchasedOn` | `YYYY-MM-DD` | Calendar date in the app's configured timezone at entry. |
| `source` | `scan`, `manual`, `list`, or `opening_stock` | Opening stock affects inventory but is excluded from purchase prediction. |
| `sessionId` | UUID string | Scanning/manual entry session. |
| `listId` | UUID string or null | Shopping draft this purchase fulfils, if any. |
| `voidedAt` | UTC ISO datetime or null | Null for active events; set when undone/corrected. |
| `replacesId` | UUID string or null | Original event if this is a corrected replacement. |

### `depletions` — key: `id`

Fields: `id`, `seq`, `barcode`, `qty`, `finishedAt`, `sessionId`, `voidedAt`, and
`replacesId`, using the equivalent types above. `qty` defaults to one pack.

### `meta` — key/value

Schema version; next event sequence; settings including timezone and category
order; last JSON backup export request; active session; and the current shopping
draft, including its ID, checked rows, quantities, and completion state.

### Stock and corrections

- One scanned retail pack is one unit. A multipack counts as one unit unless
  the user deliberately logs its contents separately. Quantities are estimates
  based on logging, not a guarantee of physical stock.
- Replay non-voided events in `seq` order. Start at zero; purchases and opening
  stock add `qty`; depletions subtract `qty`, clamped at zero.
- No effective events means `onHandQty = null` and `status = unknown`. Positive
  balance means `in_stock`. A zero balance after a depletion means `finished`.
  A first-ever depletion therefore supports day-one run-outs without purchase history.
- Buying three packs then finishing one leaves two, not a run-out. Existing
  supplies can be entered once as `opening_stock` to seed the estimate.
- Event payloads are not silently rewritten or physically deleted in normal
  use. Undo marks the event void. Editing a logged quantity voids the original
  and appends its replacement in one transaction. An undo of that edit restores
  the original and voids its replacement.
- Replacement events retain the original event's `seq`, occurrence date, and
  session/list links;
  only one active event in a replacement chain may occupy that sequence. This
  keeps a correction in its original place during inventory replay.
- Recompute derived stock after corrections and import. A recent-activity view
  supports correcting mistakes after the 10-second Undo toast has disappeared.

### Atomic writes

Create an unknown product placeholder, write its event, update stock and the
relevant draft, and allocate its sequence in one transaction. A repeated action
ID must return the existing result, not add another pack. Await transaction
completion before vibration or a success toast. Do not await a network request
inside an IndexedDB transaction.

A failed write shows **Not saved — retry** and pauses acceptance of further
scans until resolved. Lookup results update metadata separately, re-reading
current user-edited fields. Import/migration must prevent stale lookup responses
from writing into the replacement database. Handle blocked database upgrades
without clearing user data.

---

## 5. Product lookup

Commit the event locally first. Product naming is optional background work.

1. **Local catalogue:** use existing metadata immediately. A placeholder is not
   a successful lookup; unresolved entries remain eligible for queued retries.
2. **Open Food Facts:** use its documented v3 product API. The documented
   `product_type=all` option can also locate products on the sibling beauty,
   pet-food, and general-product databases.
3. **Name later:** if offline, missing, or temporarily unavailable, retain the
   barcode placeholder and put it in a non-blocking **Needs a name** queue.
   A single text field resolves it permanently; it can always be edited later.

The documented cross-project request shape is:

```text
GET https://world.openfoodfacts.org/api/v3/product/{barcode}?product_type=all
```

Pin and test the supported API sub-version and response adapter during the
build. Do not assume the old v2 numeric `status: 0` contract applies to v3, or
that every sibling endpoint has identical fields. Treat missing or malformed
product data as a miss. Map product name, brand, and quantity to local metadata;
leave category unset unless a useful aisle category can be determined.

Open Food Facts currently recommends v3 and documents a product-read limit of
15 requests per minute per IP. Use one background request at a time, no more
than one start every 5 seconds, and respect `Retry-After` plus backoff for
429/503 responses. Sharing an IP can still exhaust that allowance.
[API documentation](https://openfoodfacts.github.io/openfoodfacts-server/api/).

Cross-project redirects and responses must be tested from the deployed origin
with normal browser CORS. Treat unavailable sibling services as a fallback
failure, not an app failure.
[Sibling database documentation](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/scanning-cosmetics-pet-food-and-other-products/).

Additional requirements:

- Use a finite timeout, for example 8 seconds. Deduplicate queued requests per
  barcode; persist pending work and retry when the app is open and online.
- Cache successful results. Cache true misses for 7 days; do not misclassify
  timeouts, CORS errors, or rate limits as missing products. Allow manual retry.
- Accept a result only if its code matches the requested product after verified
  barcode normalization. Do not rename product keys from arbitrary response data.
- Use a documented browser-compatible way to identify the app; do not depend
  on overriding Chrome's `User-Agent` header. Retain provider attribution in
  Settings and metadata provenance in exports.
- Provide an **Online product names** setting. No photos, purchase history, or
  account data are uploaded. Never use `no-cors` as a supposed JSON workaround.
- User edits always win, including intentional blank fields. Render all user,
  imported, and provider text with safe text APIs, not HTML interpolation.
- UK/Tesco coverage is not guaranteed. Do not add Tesco scraping or an
  undocumented Tesco integration. Reduced-price stickers, loose produce, and
  retailer-specific labels may require an original pack barcode or manual name.

---

## 6. Scanning modes and barcode identity

The Scan tab has a large, clearly labelled **Buy / Finished** toggle. Buy is the
initial default; remember the last mode and make it conspicuous on return.

### Camera and decoder

- On entering Scan, attempt to open the rear camera with audio disabled. Use
  a muted, inline video element. Initial browser permission is unavoidable;
  show **Enable camera** or **Retry** when a user gesture is needed.
- Check `BarcodeDetector.getSupportedFormats()` before construction. Use the
  fallback when unavailable, missing required formats, or failing at runtime.
  Map native and ZXing format names explicitly.
  [BarcodeDetector reference](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector).
- Allow one decode operation in flight. Start around 5–10 attempts per second
  and tune on the Pixel. Select one stable barcode nearest the aiming region
  if several are visible; do not log every barcode in the frame.
- Stop camera tracks and decoding on leaving Scan, hiding the app, or starting
  import. Resume safely; do not leave the camera running in the background.
- Distinguish denied permission, insecure origin, unavailable camera, and
  camera-in-use errors. Always provide manual entry and never a blank screen.
- Vibration is best effort. Visual confirmation must also work without it.

### Prevent duplicate scans without slowing repeated packs

A timer alone is insufficient: a pack held in view must not be logged again
every three seconds.

After accepting a code, latch it. Rearm that code only after it has been absent
from completed detection attempts for at least 700 ms, with at least three such
attempts (empty results count; decoder errors do not). Then require two
consecutive matching detections before accepting it
again. Track this per barcode so A → B → A works predictably. Tune these initial
thresholds against false repeats and the speed target.

Removing one pack and presenting the next identical pack counts again; holding
one pack still for 10 seconds counts once. A quantity stepper is available for
identical packs that are awkward to present separately. On mode change, discard
pending detections and require removal/re-presentation before accepting a code
that is already visible.

### Buy mode

- Each accepted scan appends a `qty = 1` purchase event and increases stock.
- Aggregate the session display by barcode: the UI may show `×2`, while the log
  keeps the two separate events. Never rewrite an earlier event just to group rows.
- Clear `snoozeUntil` on a successful purchase. Undo restores that side effect
  only if no later action has changed it.
- After commit, show the current name or placeholder, quantity, and Undo.
- Keep naming prompts outside the scanning flow.

### Finished mode

- Append a one-pack depletion and reduce the estimated balance.
- If packs remain, show **Finished one · {n} left**.
- At zero, show **Ran out · added to list** only if list exclusions allow it;
  otherwise explain **Snoozed** or **Suggestions off**. Do not promise an entry
  the list will suppress.

### Accepted identifiers

Support `ean_13`, `ean_8`, `upc_a`, `upc_e`, and `code_128`, plus manual products.
Keep leading zeros. Validate numeric retail-code lengths and check digits.
Canonicalize UPC-A to its equivalent EAN-13 by adding its leading zero; expand
UPC-E correctly before applying that rule. Do not confuse an 8-digit UPC-E
with EAN-8. Preserve EAN-8 keys and test both decoder outputs.

Code 128 is not automatically a retail GTIN: use `code128:<raw value>` as a
local key and skip remote product lookup unless an explicit, tested GS1 parser
extracts a GTIN. That parser is optional. Manual products use `manual:<uuid>`
and a name, so loose fruit and damaged barcodes are still usable.

Remote systems may normalize product codes differently; match verified aliases
without merging unrelated products.
[Open Food Facts barcode normalization](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-barcode-normalization/).

---

## 7. Weekly list generation

Keep the generator pure: no database, DOM, network, or implicit current clock.

```js
generateList(products, purchases, depletions, today, settings) // -> ListItem[]
```

`today` is a `YYYY-MM-DD` date in the app's configured timezone. Use calendar-day
arithmetic, not local timestamp differences divided by 86,400,000: daylight
saving must not change a weekly interval. Preserve the recorded purchase dates
when importing or changing timezone settings.

Replay active stock events rather than trusting stale cached product status.
Ignore voided events. For historical predictions, also ignore opening-stock
entries and future-dated purchase occasions.

### Rule A — Ran out

An effective depletion leaves the current estimated balance at zero, with no
later effective stock addition restoring a positive balance.

Reason: **Ran out**. Confidence: high relative to the recorded activity.
This works for the first-ever depletion, even without purchase history.

**A purchase yesterday does not suppress an item finished today.** Actual
run-outs take precedence over the recent-purchase protection below.

### Rule B — Staple schedule

For `isStaple`, include when:

```text
daysSince(lastAddedDay) >= max(0, staplePeriodDays - 1)
```

`lastAddedDay` is the latest active purchase or opening-stock date. With no such
history, include immediately. Reason: **Scheduled staple · every {n} days**.
Confidence: high as a user-selected schedule, not a claim about exact consumption.

### Rule C — Predicted purchase

Group actual purchases by barcode and recorded calendar date, summing quantities
on that date. Multiple packs scanned on one shopping day form one purchase
occasion, not multiple zero-day intervals.

Require at least **3 distinct purchase dates**, giving at least 2 positive gaps.
Use the most recent 8 occasions, sorted by date.

```text
gaps       = consecutive calendar-day differences
typicalGap = median(gaps)
dueDay     = lastPurchaseDay + ceil(typicalGap)
include if dueDay <= today + planningHorizonDays
```

Default planning horizon: 7 days. A median reduces sensitivity to isolated long
gaps; it does not make an irregular purchasing pattern reliable.

Use Tukey's median-of-halves convention for IQR: sort gaps, exclude the central
value when the count is odd, then take the median of each half.

| Confidence | Requirement |
| --- | --- |
| High | At least 5 gaps and IQR ≤ 0.4 × typicalGap. |
| Medium | At least 3 gaps and IQR ≤ 1.0 × typicalGap, when not high. |
| Low | All other eligible histories with at least 2 gaps. |

If occasion quantities vary in the sampled history, cap predicted confidence
at low and show **Amounts bought vary — check stock**. Do not infer exact unit
consumption from purchase frequency.

Reason: **Usually bought every ~{typicalGap} days**. Prediction and staple rules
remain advisory even if estimated stock is positive, since depletion scans may
have been missed. Show estimated stock alongside those suggestions.

### Precedence and exclusions

- `neverSuggest` suppresses every automatic rule. A deliberate manual addition
  to the shopping draft remains possible.
- `snoozeUntil > today` suppresses automatic rules; the item returns on the
  snooze date itself.
- For Rules B and C only, suppress if the most recent addition was today or
  yesterday (`0 <= daysSince(lastAddedDay) < 2`). At two calendar days, the guard
  expires. Do not apply it to Rule A.
- Output each product once. Preserve all qualifying reasons, with primary
  reason priority A, then B, then C.

### Display and completing a shop

Show a **Ran out** section first, then **Other suggestions**. Within each,
group by the user's aisle/category order, put Uncategorized last, then sort
by confidence, name, and barcode as a stable tie-breaker.

Each row has a checkbox, name, size, editable quantity initially `defaultQty`,
reason, and snooze for 1, 2, or 4 weeks. Provide a visible snooze button as well
as the optional swipe gesture. Persist the draft so a reload preserves checks
and quantity edits; preserve existing draft choices when suggestions refresh.

**Done shopping** offers two explicit paths:

- **I'll scan the bags:** keep the draft open and associate ensuing Buy scans
  with its `listId`; the checklist itself creates no purchase events.
- **Log checked purchases:** write only the remaining quantity for each checked
  row after subtracting active purchases already linked to that exact `listId`.
  Write the batch and completion marker in one transaction, so repeated taps
  or a reload cannot log it twice.

Never infer duplicates merely because the same product was bought on the same
day. After a draft is manually logged, do not automatically start unpacking
scans for it: show **This shop is already recorded** and require an explicit
new/additional shopping session before further Buy scans. A scan-only draft
has a Finish session action that closes it without adding purchases.

---

## 8. Export, restore, and data retention

### Exports

Take a consistent snapshot across all stores in one read transaction.

- **JSON backup:** include `appId`, `schemaVersion`, `exportedAt`, and all four
  stores, including voided events, IDs, sequences, settings, lookup state, and
  the shopping draft. This is the authoritative restore format.
- **Excel workbook:** sheets `Products`, `Purchases`, `Depletions`, `List`, and
  `Settings`. Include provenance, source, void flags, and event IDs. Flatten
  nested fields explicitly or encode them as JSON text. The List sheet is a
  dated snapshot with reasons and quantities.
- Use ISO date text, one header row per sheet, and no merged cells. Store
  barcodes and text explicitly as text cells, preserving leading zeros; never
  turn names beginning with `=`, `+`, `-`, or `@` into spreadsheet formulas.
- Both formats work offline. Each download follows its own user action; do not
  rely on a browser allowing two automatic downloads from one click.
- Nudge a JSON backup after the first completed shop if none exists, then after
  30 days. Excel-only exports do not reset the backup reminder. Record that an
  export was requested, not a claim that the browser verified an external save.

### Import JSON — replacement only

1. Pause scans and lookup writes. Read and validate the file before modifying
   any data. Apply a documented size limit, initially 50 MiB.
2. Check app identity, supported schema version, required stores, field types,
   valid dates, finite safe integers, positive event quantities, unique IDs,
   product references, allowed enums, replacement chains, and active sequence
   uniqueness. Reject unsupported newer schemas. Support older versions only
   through explicitly tested migrations.
3. Show record counts and explain that restoration replaces current data.
   Offer a current JSON backup and require an explicit Replace confirmation.
4. Clear and repopulate all stores in **one readwrite transaction**. Any error
   or quota failure aborts the whole transaction, preserving the prior data.
   Do not delete the live database before validation or commit.
5. Recompute stock, restore IDs, set the next sequence above all imported
   sequences, and validate draft links before the same transaction commits.
   Resume normal operation only after success; discard stale lookup callbacks.

Routine corrections use Undo. Full database replacement is the deliberate
exception: backup plus confirmation, not a misleading 10-second safety toast.
Normal app upgrades must migrate existing data, not reset it.

---

## 9. Build order

Build sequentially. Each phase must run on the phone before its phone-specific
acceptance gate is marked complete. If physical access is unavailable, continue
work that can be verified locally and report those gates as pending.

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| 0 | Static shell, manifest, caching, GitHub Pages | Installs and cold-opens offline at the actual repository subpath. |
| 1 | Storage, stock replay, manual products, JSON backup/restore | Entries survive restart; invalid restore preserves existing data. |
| 2 | Buy scanning, normalization, repeat protection, Undo | Native and forced fallback work offline; 10 packs scan in under 40 seconds without duplicates. |
| 3 | Optional product lookup and naming queue | Known sample codes resolve when available; offline/missing/limited requests never interrupt logging. |
| 4 | Finished mode, catalogue, Rules A/B | Multiple-pack and buy-then-finish cases produce the correct list. |
| 5 | Persistent checklist, snoozes, purchase logging | Scan and manual completion paths do not double-log a shop. |
| 6 | Rule C and confidence | Deterministic fixtures pass; sample-size and quantity limitations are visible. |
| 7 | Excel export and final phone checks | Workbook opens correctly; full JSON restore succeeds; 30-pack speed target is measured. |

Prediction starts after three distinct purchase dates, not three packs. It may
take weeks to become useful; run-outs and staples provide value from day one.
Backup arrives before meaningful real history is accumulated.

---

## 10. Verification

Use `node --test` for pure rules, barcode normalization, stock replay, and import
validation. Browser/phone checks cover IndexedDB transactions, camera operation,
download behaviour, and service-worker updates. Do not report hardware tests as
passed based only on unit tests or a desktop mock.

Meaningful fixtures and checks:

| Case | Expected result |
| --- | --- |
| 3 purchase dates, 7-day gaps, due inside horizon | Rule C, low confidence. |
| 4 purchase dates, 7-day gaps | Rule C, medium confidence. |
| 6 purchase dates, 7-day gaps | Rule C, high confidence. |
| Gaps 7, 7, 60, 7 | Median 7; low confidence under the specified IQR rule. |
| 2 purchase dates, or 3 packs scanned on one date | Insufficient history for Rule C. |
| Buy 3, finish 1 | Estimated quantity 2; Rule A does not fire. |
| Buy 1 yesterday, finish it today | Rule A appears despite recent purchase. |
| Finish, then buy later | Rule A cleared; recent-purchase guard applies to B/C. |
| First action is a depletion | Run-out works without purchase history. |
| Correct an old purchase after later depletions | Replacement replays at its original sequence. |
| Undo a scan or quantity correction | Stock, history, and linked draft quantities are restored correctly. |
| New staple without history | Appears immediately. |
| Snoozed run-out / never-suggest run-out | Automatic suggestion suppressed. |
| Snooze ends today / purchase exactly 2 calendar days ago | Boundaries behave as specified. |
| Weekly dates across UK daylight-saving change | Gap remains 7 calendar days. |
| UPC-A and equivalent EAN-13; UPC-E versus EAN-8 | Correct identity and preserved leading zeros. |
| Late remote result after a user rename | User text preserved. |
| Hold one code for 10 seconds, then remove/re-present | One event while held; one further event after rearming. |
| Repeated completion tap, reload, or a partially scanned list | Only unlogged quantities are recorded. |
| Invalid JSON, orphan references, unsupported version, or aborted restore | Existing data unchanged. |
| Export → restore → export | All authoritative data round-trips; only documented operational/export timestamps may differ. |
| Airplane-mode cold start and forced decoder fallback | Scanning, export, and all views work. |
| Failed storage write | No success vibration/toast; retry does not duplicate an action. |
| App update with existing data | Data retained; no interruption of an active scan. |
| Empty database | Empty list, no crash. |

---

## 11. UI notes

Built for one-handed use in a kitchen.

- Four bottom tabs: **Scan**, **List**, **Catalogue**, **Settings**. Scan is the
  default launch tab, with the current mode clearly visible.
- At least 48 CSS-pixel tap targets, high contrast, large type, generous line
  spacing, left-aligned text, and dark mode by default.
- No more than two navigation levels. Respect text zoom, keyboard focus,
  reduced motion, and screen-reader labels. Do not communicate mode using
  colour alone.
- Unknown names appear in a persistent queue; no naming modal blocks scanning.
- Show offline state, offline readiness, pending names, and save failures clearly.
- Offer a 10-second Undo toast for routine corrections and keep access to recent
  activity afterward. Pausing/deleting history must never happen silently.
- Product-name editing must not steal focus or reopen the camera unexpectedly.
- Keep developer diagnostics out of ordinary product flows; Settings may show
  app version, backup status, and storage status in plain language.

---

## 12. Out of scope

- Multi-user operation, accounts, login, or cloud sync.
- Price tracking, budgeting, nutrition, recipes, and meal planning.
- Google Sheets live sync; Excel export covers the initial need.
- Native Android code, paid services, server-side proxies, or runtime CDN code.
- Exact weighing, expiry tracking, or guaranteed physical pantry inventory.
- Automatic understanding of every retailer-specific discount or variable-weight barcode.

Do not add these speculatively. Deliver the small, reliable scan → log → list
loop first, with working backups and explicit evidence for acceptance gates.
