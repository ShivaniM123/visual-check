# Parity Check capture Worker (Cloudflare, free)

Parity Check opens the original page in **Cloudflare Browser Run**, Cloudflare's headless browser in the cloud, to read it at every breakpoint and take a full-page screenshot per width. This small Cloudflare Worker runs that capture. It uses a **Browser Run binding**, so there's no API key or token anywhere: everything stays in your Cloudflare account.

- **Cost:** free, with no credit card.
  - Browser Run on the Workers free plan: **10 minutes of browser time a day**, 3 browsers at a time. One width takes about 7–10 s, so a check of 2–3 widths uses about 20–30 s: roughly 20–30 new captures a day. Re-checks reuse the captured original and cost nothing.
  - Workers free plan: 100,000 requests a day.
- **Privacy:** the Worker only receives the original page's address and the width. It stores nothing.
- **Safety:** it only answers this site's pages (its aem.page / aem.live previews and Experience Workspace). It refuses private or internal addresses, and it only runs this site's own capture script, which it reads from the site and never from the request.

## Set it up (about 5 minutes, in the browser)

You can use the Cloudflare account you already have. Use a Worker of its own: don't paste this into a Worker another extension uses.

1. Sign in at **https://dash.cloudflare.com**.
2. Open **Compute (Workers)** → **Workers & Pages**. Open your Parity Check Worker, or click **Create** → **Create Worker**, name it, and click **Deploy**.
3. Click **Edit code**, delete everything in the editor, paste the whole contents of [`capture-worker.js`](capture-worker.js), and click **Deploy**.
4. Open the Worker's **Settings** → **Bindings** → **Add binding** → **Browser Run** (it may be listed as **Browser Rendering**). Set the variable name to **`BROWSER`** and click **Deploy**.
5. In **Settings** → **Runtime**, check that the **Compatibility date** is **2026-03-24 or later** (new Workers have today's date). If it's older, change it and deploy again.
6. Open the Worker's address. It should show `{"ok":true,"service":"parity-check-capture","browser":"cloudflare-browser-run",…,"configured":true}`.

If you used Browserless before, you can delete the `BROWSERLESS_TOKEN` secret from **Settings** → **Variables and Secrets**. It isn't used any more.

For a different site, change `ORG` and `REPO` at the top of the file (or add `SITE_ORG` / `SITE_REPO` variables).

## Connect it to Parity Check

Add `service=<Worker address>` to the Parity Check row in the site's **library** sheet (`https://da.live/config#/shivanim123/visual-check/`), for example:

```
/tools/parity-check/parity-check.html?service=https://parity-check.<your-subdomain>.workers.dev&original=https://www.example.com
```

Reload Experience Workspace. An author can also enter the address in the panel's **Settings** and click **Test**.

**Branches:** the panel tells the Worker which branch it is served from, and the Worker reads that branch's capture script (`https://<branch>--visual-check--shivanim123.aem.live/tools/parity-check/lib/…`). Push the branch before testing it.

## How a capture works

For each width, the Worker asks Browser Run for a **snapshot** of the original page with this site's capture script added to it (`lib/extract.js` + `lib/capture-fn.js`). In the page, the script waits for late content, scrolls through so lazy content loads, and reads every element's text, position and styles. It writes the result into the page, and Browser Run returns the rendered page plus a full-page screenshot. The Worker passes that answer straight through to the panel, which reads the parity data out of it. The free plan allows 10 ms of processing per request, so the Worker doesn't unpack anything itself.

When the panel's breakpoints are on **Auto**, it first takes one snapshot at 1280px to read the original's breakpoints, then captures the widths it needs, two at a time.

**Pages that block added scripts** with a strict security policy (CSP) can't be read this way. The panel says so instead of showing wrong results.
