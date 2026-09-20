# Vendored browser dependencies

All runtime code is stored here so installed copies work without a CDN. Versions
are deliberately pinned; update the JavaScript and matching WASM together.

| File | Version | Source | SHA-256 | Licence |
| --- | --- | --- | --- | --- |
| `idb-8.0.3.umd.js` | 8.0.3 | `https://cdn.jsdelivr.net/npm/idb@8.0.3/build/umd.js` | `ff4b3763d5b8e7981f606cb3d46df37ac5b7fc1d4b4eca34da129b47219edd59` | ISC (`LICENSE-idb.txt`) |
| `zxing-wasm-reader-3.1.4.js` | 3.1.4 | `https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.4/dist/iife/reader/index.js` | `d33d09ce132a692faffbed0dce656c36cb2573b4b843885a6e036390d1071d95` | MIT (`LICENSE-zxing-wasm.txt`); embedded ZXing-C++ is Apache-2.0 |
| `zxing_reader-3.1.4.wasm` | 3.1.4 | `https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.4/dist/reader/zxing_reader.wasm` | `e8af31edb56d0522f4de74495839385ef019ba8bc90d38e5ecb2f18795d86fb2` | MIT / Apache-2.0 as above |
| `xlsx-0.20.3.full.min.js` | 0.20.3 | `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js` | `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41` | Apache-2.0 (`LICENSE-sheetjs.txt`) |

The app configures the ZXing reader with an explicit local `locateFile` URL
before its first decode. No runtime dependency uses a CDN.
