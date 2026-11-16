# Parity Check

**See every visible difference between the page you're editing and its original page, at the original site's breakpoints, without leaving Experience Workspace.**

Parity Check is an Experience Workspace (da.live) extension. It opens as a side panel next to the page you're editing, compares it with the page it was migrated from, and pins every difference on both pages side by side. It's the in-editor version of [parity-check PR #1](https://github.com/ShivaniM123/parity-check/pull/1), with the same parity rules, and it checks one page: the one you have open.

| | |
|---|---|
| Third party | [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) (Cloudflare's headless browser, Workers free plan: 10 minutes of browser time a day) through a small [capture Worker](worker/README.md): opens the original page in the cloud, reads it at every breakpoint and takes a full-page screenshot per width. No API key or token. |
| Panel | `https://main--visual-check--shivanim123.aem.live/tools/parity-check/parity-check.html` |
| Demo | `https://main--visual-check--shivanim123.aem.live/tools/parity-check/parity-check.html?demo` |

## Why authors need it

After a page is migrated, the author has to answer: *does it look like the original?* Without a tool that means flipping between two tabs at several window sizes and guessing. Small differences slip through: a different font, a missing section, three cards per row instead of two, a button with the wrong colour, a changed word.

Parity Check answers it in the editor, for the page you're working on, at each of the original site's breakpoints. Each difference comes with its original and migrated values, so it can be fixed straight away or handed to AEM Coder.

## Features

### 1. Checks the page you're editing
- **Two boxes, two URLs.** The author enters the **Original page URL** and the **Migrated page URL** (its preview `…aem.page` or live `…aem.live` address). Both start empty, and nothing runs until **Check this page**. Pages are checked by their URLs, as visitors get them, never from the Document Authoring source; editor addresses pasted in either box (`da.live/canvas#/…`, `da.live/edit#/…`) are turned into the page's public URL.
- When you edit the page after a check, the panel says "The page changed since the last check" with a **Check again** button.

### 2. The original's breakpoints
- **Auto** (default) tests the original's own breakpoints, read from its CSS, plus a phone width (390px) when the smallest breakpoint is above 480px.
- **Or choose them yourself**, up to 5 widths per check: turn **Auto** off, tap the quick picks (**Phone 390**, **Tablet 768**, **Small laptop 1024**, **Desktop 1280**, **Wide 1440**), or type any widths, several at once (`600, 1920`), and press **Add** or Enter. Remove a width with its ×. Widths are remembered per site, and every width is checked on both pages.
- Tells you which of the original's breakpoints the migrated CSS doesn't have ("The migrated CSS has no media query at 1024px").

### 3. The parity checks (from the PR, unchanged)
- Missing, extra or changed content. Wording issues name the exact words, e.g. *"hosts" → "host"; extra "2" at the end*.
- Columns per row, spacing, font family, size, weight, line height, letter spacing, casing and alignment, text and background colour, buttons, image size and crop.
- Elements hidden or shown per width, social embeds, failed fonts and requests, horizontal scrolling, page height.
- Content is matched by what it says, not where it sits, so moved or rebuilt sections aren't reported as missing.

### 4. Results and review
- A parity score (0–100) for the page and for each width, with High / Medium / Low counts.
- **Section by section**: issues are listed under the migrated page's sections (Header, “Section 1: <its first heading>”, …, Footer, then whole-page issues), in page order. The comparison tab and the PDF use the same sections.
- **Side by side**: both pages' screenshots at the selected width. They scroll together section by section, as in the PR (the content in the middle of one pane is brought to the middle of the other), and every issue is pinned on both. Click a pin to open its issue.
- Each issue shows the original and migrated values as a table (font, size, colour, padding…), with changed words highlighted.
- Mark each issue **Approve** (`A`, an intended difference) or **Needs fix** (`F`); move between issues with `←` `→`. Approvals are kept per page.

### 5. Comparison in a new tab
- **Open comparison in new tab** (bottom of the panel) shows the original and this page side by side at full size, with every issue pinned and listed next to them, a tab per width, severity filters and arrow-key navigation.
- The panel sends the results, with both pages' screenshots, to the tab directly (inside Experience Workspace the two can't share browser storage).

### 6. PDF report
- **Download PDF** (in the panel and in the comparison tab) saves a PDF file: a cover with the score, the widths and the original's breakpoints, then a section per width with every issue (title, details, original and migrated values, element, block, Approve / Needs fix status) and a crop of the original's screenshot showing where it is.
- The PDF is made in the browser, from the check's results: no library and no service.

## How it works

| Page | How it's read |
|---|---|
| **The original** | The panel asks the site's **capture Worker**, which opens the original in **Cloudflare Browser Run** (one browser session for every width) and adds this site's capture script to it (`lib/extract.js` + `lib/capture-fn.js`, read from the site, never from the request). The page's security policy is switched off for that tab, so strict sites such as Edge Delivery pages can be read. At each width the script reads every element with the parity core, and the Worker takes a screenshot. About 10–20 s of browser time for a capture of 2–3 widths. |
| **The migrated page** | Opened the same way, by the URL entered (for example `https://main--visual-check--shivanim123.aem.page/…`), in the same cloud browser session with the same settings. |

Then, as in the PR's `run.js`: `match.js` pairs the elements by content (section by section, so moved sections aren't reported as missing), `diff.js` compares the two screenshots pixel by pixel with **pixelmatch** (the PR's diff, run in the browser), and `rules.js` turns the differences into issues and a score. `extract.js`, `match.js`, `rules.js`, `words.js`, `prompt.js` and `breakpoints.js` are the PR's, unchanged; with both pages captured alike, the results are the PR's results. Scrollbars are hidden during capture, as in the PR's browser, so each width is the page's real layout width.

**The original is captured once.** The original site doesn't change while a page is migrated, so the capture is kept in the browser. Every re-check after a fix reuses it (no Cloudflare browser time) and runs straight away when the panel opens. **Capture again** takes a fresh one.

## Install

1. Set up the free capture Worker in your Cloudflare account (about 5 minutes in the browser, no key or token): see [worker/README.md](worker/README.md).
2. Merge to `main`. The panel is then served at `/tools/parity-check/parity-check.html`.
3. Open `https://da.live/config#/shivanim123/visual-check/`, go to the **library** sheet and add a row:

   | title | path | icon | experience |
   |---|---|---|---|
   | Parity Check | `/tools/parity-check/parity-check.html?service=https://parity-check.<subdomain>.workers.dev` | `/tools/parity-check/icon.svg` | `inline` |

   - A relative path (starting with `/`) loads the panel from this site; an absolute URL works too.
   - `service=` is the capture Worker's address (from step 1). An author can also enter it in **Settings**.
   - If the site has no `library` sheet yet, add it with the **+** button next to the sheet tabs.
4. Save the config, reload Experience Workspace, open a page and choose **Parity Check** in the side-panel switcher.

**Testing a branch:** add a second row with `ref` set to the branch name, or open Workspace with `?ref=<branch>`. Push the branch first: the Worker reads that branch's capture code.

## Settings (gear icon)

- **Capture Worker address**, with a **Test** button: the Worker that opens originals in Cloudflare's cloud browser for this site. Empty means the one in the library row. No key or token is needed anywhere.
- **Ignore elements**: CSS selectors hidden on both pages before comparing (cookie banners are ignored by default).

## Demo

Open the panel address with `?demo`. It compares two sample pages with deliberate differences (font, button, image crop, columns, spacing, a missing section, an embed). Both are on this site, so the demo runs in the panel, with no capture Worker needed. Add `&cloud&service=<Worker address>` to capture the demo original with Cloudflare Browser Run as well (on aem.page / aem.live, where Cloudflare can reach it).

## Limits

- **One page at a time.** The page you're editing, at every width you choose.
- **Cloudflare's free plan** opens one new browser every 20 seconds (a check uses one; the panel waits and retries when needed) and gives 10 minutes of browser time a day: about 30–60 new captures of 2–3 widths. Re-checks of a captured original are free, and the panel says when the day's time is used up.
- **The original must be public**, because Cloudflare opens it from the internet.
- **Pages are checked by their URLs.** Preview (or publish) your edits, then check again. Both pages must be public, because Cloudflare opens them from the internet. The capture Worker is required (only the demo runs without it).
- **A first pass, not a final verdict.** Carousels, tabs, accordions and personalised content can produce wrong issues. Approve intended differences and add noisy areas to **Ignore elements**.

## Files

```
tools/parity-check/
├── parity-check.html / .css / .js   # the panel
├── compare.html / compare.js        # the full-size comparison tab
├── icon.svg
├── demo/                            # two sample pages with deliberate differences (from the PR)
└── lib/
    ├── extract.js, match.js, rules.js, words.js, prompt.js, breakpoints.js   # parity core, unchanged from the PR
    ├── cloud.js       # asks the capture Worker for a page, unpacks the results
    ├── diff.js        # the PR's pixel diff (pixelmatch), in the browser
    ├── sections.js    # the migrated page's sections, for grouping issues
    ├── vendor/pixelmatch.js  # pixelmatch 7.1.0 (ISC), unchanged
    ├── capture-fn.js  # the capture script run in the original page in Cloudflare's browser
    ├── frame.js       # renders this page in the panel and reads it
    ├── compare.js     # one check, every width (like the PR's run.js)
    ├── visual.js      # side-by-side view with pins
    ├── pdf.js         # the PDF report (a small PDF writer + the layout)
    ├── report.js      # issue keys and review statuses
    ├── settings.js    # original address, widths, ignore list, approvals
    └── store.js       # browser storage (captured originals in IndexedDB)
worker/
    ├── capture-worker.js  # the Cloudflare Worker (paste into the dashboard, add a Browser Run binding)
    └── README.md          # setup, about 5 minutes
```

`worker/` is listed in the repository's `.hlxignore`, so the site doesn't serve it.
