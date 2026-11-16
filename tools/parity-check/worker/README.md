# Parity Check capture Worker (Cloudflare, free)

Parity Check opens the original page in **Cloudflare Browser Run**, Cloudflare's headless browser in the cloud, to read it at every breakpoint and take a full-page screenshot per width. This small Cloudflare Worker runs that capture. It uses a **Browser Run binding**, so there's no API key or token anywhere: everything stays in your Cloudflare account.

- **Cost:** free, with no credit card.
  - Browser Run on the Workers free plan: **10 minutes of browser time a day**, 3 browsers at a time, and **one new browser every 20 seconds**. A check reads the original and this page in the same browser session, so it needs one; if another check starts within 20 seconds, the panel waits and retries by itself. A capture of 2–3 widths takes about 10–20 s in one browser session: roughly 30–60 new captures a day. Re-checks reuse the captured original and cost nothing.
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
6. Open the Worker's address. It should show `{"ok":true,"service":"parity-check-capture","browser":"cloudflare-browser-run","version":3,…,"configured":true}`.

If you used Browserless before, you can delete the `BROWSERLESS_TOKEN` secret from **Settings** → **Variables and Secrets**. It isn't used any more.

For a different site, change `ORG` and `REPO` at the top of the file (or add `SITE_ORG` / `SITE_REPO` variables).

## Connect it to Parity Check

Add `service=<Worker address>` to the Parity Check row in the site's **library** sheet (`https://da.live/config#/shivanim123/visual-check/`), for example:

```
/tools/parity-check/parity-check.html?service=https://parity-check.<your-subdomain>.workers.dev
```

Reload Experience Workspace. An author can also enter the address in the panel's **Settings** and click **Test**.

**Branches:** the panel tells the Worker which branch it is served from, and the Worker reads that branch's capture script (`https://<branch>--visual-check--shivanim123.aem.live/tools/parity-check/lib/…`). Push the branch before testing it.

## How a capture works

The Worker asks the binding for a browser session and drives it over the Chrome DevTools Protocol, the same way Cloudflare's own Puppeteer library does with the binding. For each capture it:

1. opens a tab and **switches off the page's Content Security Policy for that tab** (Edge Delivery pages and many other sites only run scripts they signed themselves, which would block the capture);
2. opens the original page and adds this site's capture script to it (`lib/extract.js` + `lib/capture-fn.js`, read from the site);
3. reads the original's breakpoints from its CSS (when the panel is on **Auto**);
4. at every width, in the same session: waits for late content, scrolls through so lazy content loads, reads every element's text, position and styles, and takes a screenshot.

One session covers every width: about 5 s per width, plus the page load. The results are passed on to the panel as text, without unpacking them, so the Worker stays far below the free plan's 10 ms of processing per request.
