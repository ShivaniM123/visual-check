# Parity Check

**See every visible difference between an original page and its migrated page, at the original site's breakpoints, without leaving Experience Workspace.**

Parity Check is an Experience Workspace (da.live) extension. It opens as a side panel next to the page you're editing. You enter two URLs, the original page and the migrated page, and it compares them the way [parity-check PR #1](https://github.com/ShivaniM123/parity-check/pull/1) does: same capture, same parity rules, same pixel comparison, same results. It checks one pair of pages at a time.

| | |
|---|---|
| Third party | [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/), Cloudflare's headless browser, through a small [capture Worker](worker/README.md) (Workers free plan, no API key or token): opens both pages by their URLs, reads them at every breakpoint and takes a screenshot per width |
| Panel (this branch) | `https://aem-20261116-2344--visual-check--shivanim123.aem.live/tools/parity-check/parity-check.html` |
| Panel (after merging to `main`) | `https://main--visual-check--shivanim123.aem.live/tools/parity-check/parity-check.html` |
| Demo | add `?demo` to the panel address |

## Why authors need it

After a page is migrated, the author has to answer: *does it look like the original?* Without a tool that means flipping between two tabs at several window sizes and guessing. Small differences slip through: a different font, a missing section, three cards per row instead of two, a button with the wrong colour, a changed word.

Parity Check answers it in the editor, at each of the original site's breakpoints, section by section. Each difference comes with its original and migrated values, so it can be fixed straight away.

## Features

### 1. Two URLs
- **Original page URL** and **Migrated page URL**: the author types both. Both boxes start empty, and nothing runs until **Check this page** (or Enter in either box).
- The migrated page is checked by the URL you enter: its preview (`https://main--visual-check--shivanim123.aem.page/…`) or live (`…aem.live/…`) address. Pages are always checked by their URLs, as visitors get them, never from the Document Authoring source, so **preview (or publish) your edits before checking**.
- Editor addresses pasted in either box (`da.live/canvas#/org/site/path`, `da.live/edit#/…`, `…preview.da.live/…`) are turned into the page's public URL, with a note saying so.
- Clear messages for a missing URL, or the same URL in both boxes. When you edit the page after a check, the panel says "The page changed since the last check".

### 2. Breakpoints
- **Auto** (default): the original's own breakpoints, read from its CSS, plus a phone width (390px) when the smallest breakpoint is above 480px.
- **Or choose them yourself**, up to 5 widths per check: turn **Auto** off, tap the quick picks (**Phone 390**, **Tablet 768**, **Small laptop 1024**, **Desktop 1280**, **Wide 1440**), or type any widths, several at once (`600, 1920`), and press **Add** or Enter. Remove a width with its ×. Widths are remembered per site.
- Tells you which of the original's breakpoints the migrated CSS doesn't have ("The migrated CSS has no media query at 1024px").

### 3. The parity checks (from the PR, unchanged)
- Missing, extra or changed content. Wording issues name the exact words, e.g. *"€49" → "€59"; "15%" → "10%"*, spelling (*"receive" → "recieve"*), names and missing words. Short texts edited in place (a number on its own, a button label, a short line) are compared as one element too (`lib/edits.js`), so they show as *Wording: "2026" → "2025"*, not as missing and extra content.
- Columns per row, spacing, font family, size, weight, line height, letter spacing, casing and alignment, text and background colour, buttons, image size and crop.
- Elements hidden or shown per width, social embeds, failed fonts and requests, horizontal scrolling, page height.
- A pixel-by-pixel comparison of the two screenshots (the PR's `diff.js` with pixelmatch), which goes into the score and confirms, for example, whether text really is bolder.
- Content is matched by what it says, section by section, so moved or rebuilt sections aren't reported as missing.
- **A page that loads without its styles** (no stylesheets, web fonts or site scripts at that URL, e.g. a site whose code isn't on that branch) is flagged in red above the results, because then nearly every element differs.

### 4. Results and review
- A parity score (0–100) for the page and for each width, with High / Medium / Low counts and filters.
- **Section by section**: issues are listed under the migrated page's sections, in page order: Header, "Section 1: *its first heading*", …, Footer, then whole-page issues. The comparison tab and the PDF use the same sections.
- **Side by side**: both pages' screenshots at the selected width, with every issue pinned on both. They scroll together section by section, as in the PR (the content in the middle of one pane is brought to the middle of the other). Click a pin or an issue to jump to it on both pages.
- Each issue shows the original and migrated values as a table (font, size, colour, padding…), with changed words highlighted.
- Mark each issue **Approve** (`A`, an intended difference) or **Needs fix** (`F`); move between issues with `←` `→`. Approvals are kept per page.

### 5. Comparison in a new tab
- **Open comparison in new tab** (bottom of the panel): both screenshots side by side at full size, every issue pinned and listed by section, a tab per width, severity filters, arrow-key navigation and **Download PDF**.
- The panel sends the results to the tab directly (inside Experience Workspace the two can't share browser storage).

### 6. PDF report
- **Download PDF** (in the panel and in the comparison tab) saves a PDF file: a cover with the score, both URLs, the widths, the original's breakpoints and a per-width summary, then a section per width with every issue, grouped by page section (title, details, original and migrated values, element, block, Approve / Needs fix status) and a crop of the original's screenshot outlining where it is.
- The PDF is made in the browser from the check's results: no library and no service.

## How it works

1. The panel sends both URLs to the site's **capture Worker** (Cloudflare, free plan).
2. The Worker opens one browser session in **Cloudflare Browser Run** and, in that session, opens the original, then the migrated page. In each it switches off the page's security policy for the tab (Edge Delivery pages and many other sites block added scripts), adds this site's capture script (`lib/extract.js` + `lib/capture-fn.js`, read from the site, never from the request) and, at every width: waits for late content, scrolls through so lazy content loads, hides the scrollbar (as the PR's browser does), reads every element's text, position and styles, and takes a full-size screenshot.
3. The panel compares the two pages as the PR's `run.js` does: `match.js` pairs the elements by content, `diff.js` compares the screenshots pixel by pixel with pixelmatch, and `rules.js` turns the differences into issues and a score. `sections.js` then places each issue in its section of the migrated page.

`extract.js`, `match.js`, `rules.js`, `words.js`, `prompt.js` and `breakpoints.js` are the PR's files, unchanged. With both pages captured alike, the results are the PR's: checked on the same pages, the panel and the PR's own tool found the same issues at every width. Scores can differ by about a point, because the screenshots travel as JPEG instead of the PR's PNG.

**Both pages are captured fresh for every check**, at the same moment, in the same browser session. Nothing is reused from an earlier check, so the result always reflects both pages as they are now, and swapping the two pages gives a mirrored result (the same issues, the same score).

**Time per check:** about 20 s for 2–3 widths.

## Install

1. Set up the free capture Worker in your Cloudflare account (about 5 minutes in the browser, no key or token): see [worker/README.md](worker/README.md).
2. Merge to `main` (or use a branch, below). The panel is served at `/tools/parity-check/parity-check.html`.
3. Open `https://da.live/config#/shivanim123/visual-check/`, go to the **library** sheet and add a row:

   | title | path | icon | experience |
   |---|---|---|---|
   | Parity Check | `https://main--visual-check--shivanim123.aem.live/tools/parity-check/parity-check.html?service=https://<worker>.workers.dev` | `https://main--visual-check--shivanim123.aem.live/tools/parity-check/icon.svg` | `inline` |

   - `service=` is the capture Worker's address (from step 1). An author can also enter it in **Settings**.
   - If the site has no `library` sheet yet, add it with the **+** button next to the sheet tabs.
4. Save the config, reload Experience Workspace, open a page and choose **Parity Check** in the side-panel switcher.

**Using a branch:** point the row's `path` and `icon` at the branch, e.g. `https://aem-20261116-2344--visual-check--shivanim123.aem.live/tools/parity-check/parity-check.html?service=…`, and push the branch first: the panel tells the Worker which branch it runs on, and the Worker reads that branch's capture script.

## Settings (gear icon)

- **Capture Worker address**, with a **Test** button. Empty means the one in the library row (`?service=`). No key or token is needed anywhere.
- **Ignore elements**: CSS selectors hidden on both pages before comparing (cookie banners are ignored by default).

## Demo

Open the panel address with `?demo`. It compares two sample pages from the PR, with deliberate differences (font, button, image crop, columns, spacing, a missing section, an embed). Both are on this site, so the demo fills in their URLs itself and runs in the panel, without the capture Worker and without a pixel comparison. Add `&cloud&service=<Worker address>` to open them in Cloudflare's browser as well.

## Limits

- **One pair of pages at a time**, at up to 5 widths.
- **Both pages must be public**, because Cloudflare opens them from the internet. Check previews (`…aem.page`) or live pages (`…aem.live`), not editor addresses.
- **The capture Worker is required** (only the demo runs without it).
- **Cloudflare's free plan**: one new browser every 20 seconds (a check uses one; if another check starts sooner, the panel waits and retries), 3 browsers at a time, and 10 minutes of browser time a day, roughly 30 checks. The panel tells "wait a few seconds" apart from "today's time is used up".
- **A first pass, not a final verdict.** As with the PR's tool, carousels, tabs, accordions and personalised content can produce wrong issues. Approve intended differences and add noisy areas to **Ignore elements**.

## Files

```
tools/parity-check/
├── parity-check.html / .css / .js   # the panel
├── compare.html / compare.js        # the full-size comparison tab
├── icon.svg
├── demo/                            # two sample pages with deliberate differences (from the PR)
├── lib/
│   ├── extract.js, match.js, rules.js, words.js, prompt.js, breakpoints.js   # parity core, unchanged from the PR
│   ├── capture-fn.js  # the capture script run in each page in Cloudflare's browser
│   ├── cloud.js       # asks the capture Worker for the pages, unpacks the results, waits and retries
│   ├── compare.js     # one check at every width (like the PR's run.js), unstyled-page warning
│   ├── diff.js        # the PR's pixel diff (pixelmatch), in the browser
│   ├── edits.js       # pairs short texts edited in place (a number, a label) before the rules run
│   ├── sections.js    # the migrated page's sections, for grouping issues
│   ├── visual.js      # side-by-side screenshots with pins, section-aligned scrolling
│   ├── pdf.js         # the PDF report (a small PDF writer + the layout)
│   ├── frame.js       # reads the demo's sample pages in the panel
│   ├── report.js      # issue keys and review statuses
│   ├── settings.js    # capture Worker, widths, ignore list, approvals
│   ├── store.js       # browser storage for settings and review statuses
│   └── vendor/pixelmatch.js  # pixelmatch 7.1.0 (ISC), unchanged
└── worker/
    ├── capture-worker.js  # the Cloudflare Worker (paste into the dashboard, add a Browser Run binding)
    └── README.md          # setup, about 5 minutes
```

`worker/` is listed in the repository's `.hlxignore`, so the site doesn't serve it.
