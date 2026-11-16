# Parity Check capture Worker (Cloudflare, free)

Parity Check opens both pages, the original and the migrated page, in **Cloudflare Browser Run**, Cloudflare's headless browser in the cloud, to read them at every breakpoint and take a screenshot per width. This small Cloudflare Worker runs that capture. It uses a **Browser Run binding**, so there's no API key or token anywhere: everything stays in your Cloudflare account.

- **Cost:** free, with no credit card.
  - Browser Run on the Workers free plan: **10 minutes of browser time a day**, 3 browsers at a time, and **one new browser every 20 seconds**. A check reads both pages in one browser session, so it needs one browser: about 20 s for 2–3 widths, or about 10 s for a re-check (the original's capture is reused). That's roughly 30–60 checks a day. If another check starts within 20 seconds, the panel waits and retries by itself.
  - Workers free plan: 100,000 requests a day.
- **Privacy:** the Worker only receives the two page URLs, the widths and the elements to ignore. It stores nothing.
- **Safety:** it only answers this site's pages (its aem.page / aem.live previews and Experience Workspace). It refuses private or internal addresses, and it only runs this site's own capture script, which it reads from the site and never from the request.

## Set it up (about 5 minutes, in the browser)

You can use the Cloudflare account you already have. Use a Worker of its own: don't paste this into a Worker another extension uses.

1. Sign in at **https://dash.cloudflare.com**.
2. Open **Compute (Workers)** → **Workers & Pages**. Open your Parity Check Worker, or click **Create** → **Create Worker**, name it, and click **Deploy**.
3. Click **Edit code**, delete everything in the editor, paste the whole contents of [`capture-worker.js`](capture-worker.js), and click **Deploy**.
4. Open the Worker's **Settings** → **Bindings** → **Add binding** → **Browser Run** (it may be listed as **Browser Rendering**). Set the variable name to **`BROWSER`** and click **Deploy**. Make sure you're in the right Worker: the page header must show its name.
5. Open the Worker's address. It should show `{"ok":true,"service":"parity-check-capture","browser":"cloudflare-browser-run","version":4,…,"configured":true}`.

`"configured": false` means the `BROWSER` binding is missing on this Worker. A lower `version` means an older copy of the code: paste `capture-worker.js` again (older copies still work, but need two browsers per check, so a first check waits 20 seconds in between).

For a different site, change `ORG` and `REPO` at the top of the file (or add `SITE_ORG` / `SITE_REPO` variables).

## Connect it to Parity Check

Add `service=<Worker address>` to the Parity Check row's `path` in the site's **library** sheet (`https://da.live/config#/shivanim123/visual-check/`), for example:

```
https://main--visual-check--shivanim123.aem.live/tools/parity-check/parity-check.html?service=https://<worker>.workers.dev
```

Reload Experience Workspace. An author can also enter the address in the panel's **Settings** and click **Test**.

**Branches:** the panel tells the Worker which branch it is served from, and the Worker reads that branch's capture script (`https://<branch>--visual-check--shivanim123.aem.live/tools/parity-check/lib/…`). Push the branch before testing it.

## How a capture works

The Worker asks the binding for a browser session and drives it over the Chrome DevTools Protocol, the same way Cloudflare's own Puppeteer library does with the binding. For each check it opens one tab and:

1. **switches off the page's Content Security Policy for that tab** (Edge Delivery pages and many other sites only run scripts they signed themselves, which would block the capture);
2. opens the original page and adds this site's capture script to it (`lib/extract.js` + `lib/capture-fn.js`, read from the site);
3. reads the original's breakpoints from its CSS (when the panel is on **Auto**);
4. at every width: waits for late content, scrolls through so lazy content loads, hides the scrollbar, reads every element's text, position and styles, and takes a screenshot;
5. opens the migrated page in the same tab and does steps 1, 2 and 4 again at the same widths;
6. closes the browser.

The results are passed on to the panel as text, without unpacking them, so the Worker stays far below the free plan's 10 ms of processing per request.
