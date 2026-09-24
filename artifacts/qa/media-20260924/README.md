# Admin media acceptance evidence

Run from the repository root after `npm run build`.
Start `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4187 --outDir dist/client --strictPort` in a separate terminal, then run `node artifacts/qa/media-20260924/capture.mjs`.
The harness uses controlled API responses and synthetic images; it does not access production storage.
Actual browser-to-workerd/D1/R2 uploads are independently tested by `tests/media-upload-browser.test.mjs` as part of `npm run test:sites`.
