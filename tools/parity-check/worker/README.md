# Parity Check capture Worker (Cloudflare + Browserless, both free)

Parity Check opens the original page in **Browserless**, a real Chrome in the cloud, to read it at every breakpoint and take a screenshot per width. Browserless's key must stay on a server, so this small Cloudflare Worker sits in between. It adds the key, and it runs only this site's own capture code (read from the site, never from the request).

- **Cost:** free, with no credit card for either service.
  - Browserless free plan: 1,000 units a month. A unit is up to 30 s of browser time, and one check of a page at 2–4 widths usually takes one unit, so about 1,000 captures a month. Re-checks reuse the captured original and cost nothing.
  - Cloudflare Workers free plan: 100,000 requests a day.
- **Privacy:** the Worker only receives the original page's address and the widths. It stores nothing.
- **Safety:** it only answers this site's pages (its aem.page / aem.live previews and Experience Workspace), it refuses private or internal addresses, and it can only run this site's capture.

## 1. Get a Browserless key (about 2 minutes)

1. Go to **https://www.browserless.io/sign-up** and create a free account (no credit card).
2. In the Browserless account page, copy your **API key**.

## 2. Create the Worker (about 5 minutes, in the browser)

1. Sign in at **https://dash.cloudflare.com** (or create a free account).
2. Open **Compute (Workers)** → **Workers & Pages**, click **Create** → **Create Worker**, name it **`parity-check`** and click **Deploy**.
3. Click **Edit code**, delete everything in the editor, paste the whole contents of [`capture-worker.js`](capture-worker.js), and click **Deploy**.
4. Open the Worker's **Settings** → **Variables and Secrets** → **Add**. Choose type **Secret**, name it **`BROWSERLESS_TOKEN`**, paste the Browserless API key as its value, and click **Deploy**.
5. Copy the Worker's address, e.g. `https://parity-check.<your-subdomain>.workers.dev`. Opening it should show `{"ok":true,"service":"parity-check-capture",…,"configured":true}`.

For a different site, change `ORG` and `REPO` at the top of the file (or add `SITE_ORG` / `SITE_REPO` variables).

## 3. Connect it to Parity Check

Add `service=<Worker address>` to the Parity Check row in the site's **library** sheet (`https://da.live/config#/shivanim123/visual-check/`), for example:

```
/tools/parity-check/parity-check.html?service=https://parity-check.<your-subdomain>.workers.dev&original=https://www.example.com
```

Reload Experience Workspace. An author can also enter the address in the panel's **Settings** and click **Test**.

**Branches:** the panel tells the Worker which branch it runs on, and the Worker reads that branch's capture code (`https://<branch>--visual-check--shivanim123.aem.live/tools/parity-check/lib/…`). Push the branch before testing it.
