# Parity Check

**See every visible difference between the page you're editing and its original page, at the original site's breakpoints, without leaving Experience Workspace.**

Parity Check is an Experience Workspace (da.live) extension. It opens as a side panel next to the page you're editing, compares it with the page it was migrated from, and pins every difference on both pages side by side. It's the in-editor version of [parity-check PR #1](https://github.com/ShivaniM123/parity-check/pull/1), with the same parity rules, and it checks one page: the one you have open.

| | |
|---|---|
| Third party | [Browserless](https://www.browserless.io) (hosted Chrome, free plan: 1,000 units a month, no credit card): opens the original page in the cloud, reads it at every breakpoint and takes a screenshot per width |
| | [Cloudflare Workers](worker/README.md) (free plan): a small capture Worker that keeps the Browserless key secret and only runs this site's capture |
| Panel | `https://main--visual-check--shivanim123.aem.live/tools/parity-check/parity-check.html` |
| Demo | `https://main--visual-check--shivanim123.aem.live/tools/parity-check/parity-check.html?demo` |

## Why authors need it

After a page is migrated, the author has to answer: *does it look like the original?* Without a tool that means flipping between two tabs at several window sizes and guessing. Small differences slip through: a different font, a missing section, three cards per row instead of two, a button with the wrong colour, a changed word.

Parity Check answers it in the editor, for the page you're working on, at each of the original site's breakpoints. Each difference comes with its original and migrated values, so it can be fixed straight away or handed to AEM Coder.

## Features

### 1. Checks the page you're editing
- The panel knows the open page from the editor. The original's address is filled in for you: from the site's original address (set once, or learned from the first page you check), or from what you used for this page last time.
- **It checks your latest edits.** In Experience Workspace the panel renders the page from its Document Authoring source, so changes show up before you preview them.
- When you edit the page after a check, the panel says "The page changed since the last check" with a **Check again** button.

### 2. The original's breakpoints
- **Auto** (default) tests the original's own breakpoints, read from its CSS, plus a phone width (390px) when the smallest breakpoint is above 480px. You can also add or remove widths as chips. Widths are remembered per site.
- Tells you which of the original's breakpoints the migrated CSS doesn't have ("The migrated CSS has no media query at 1024px").

### 3. The parity checks (from the PR, unchanged)
- Missing, extra or changed content. Wording issues name the exact words, e.g. *"hosts" → "host"; extra "2" at the end*.
- Columns per row, spacing, font family, size, weight, line height, letter spacing, casing and alignment, text and background colour, buttons, image size and crop.
- Elements hidden or shown per width, social embeds, failed fonts and requests, horizontal scrolling, page height.
- Content is matched by what it says, not where it sits, so moved or rebuilt sections aren't reported as missing.

### 4. Results and review
- A parity score (0–100) for the page and for each width, with High / Medium / Low counts.
- **Side by side**: the original (Browserless's screenshot) and this page (rendered live) at the selected width. They scroll together through the matching content, and every issue is pinned on both. Click a pin to open its issue.
- Each issue shows the original and migrated values as a table (font, size, colour, padding…), with changed words highlighted.
- Mark each issue **Approve** (`A`, an intended difference) or **Needs fix** (`F`); move between issues with `←` `→`. Approvals are kept per page.

### 5. Hand-off
- **Ask in Chat**: puts a ready prompt with the page's open issues (element, original and migrated values, widths) into the Workspace chat, for you to review and send. Approved issues are left out.
- **Copy for AEM Coder**: the same prompt, on the clipboard.
- **Download report**: a Markdown report with every issue per width and its status.

## How it works

| Page | How it's read |
|---|---|
| **The original** | The panel asks the site's **capture Worker** (Cloudflare), which runs the capture in **Browserless**'s cloud Chrome. The Worker reads the capture code from this site (`lib/extract.js` + `lib/capture-fn.js`), never from the request, so it can only run this site's capture. Browserless opens the original, reads it at every width with the parity core, and returns the element data and a screenshot per width. **One capture per check** (usually one Browserless unit), whatever the number of widths. |
| **This page** | Rendered inside the panel at each width, on the same site as the panel, and read with the same parity core. No third party, no limit. |

Then `match.js` pairs the elements by content, `rules.js` turns differences into issues and a score, and `prompt.js` writes the hand-off. These files, `extract.js`, `words.js` and `breakpoints.js` are the PR's, unchanged.

**The original is captured once.** The original site doesn't change while a page is migrated, so the capture is kept in the browser. Every re-check after a fix reuses it (no Browserless call) and runs straight away when the panel opens. **Capture again** takes a fresh one.

## Install

1. Set up the free capture Worker (Cloudflare + Browserless, about 10 minutes in the browser): see [worker/README.md](worker/README.md).
2. Merge to `main`. The panel is then served at `/tools/parity-check/parity-check.html`.
3. Open `https://da.live/config#/shivanim123/visual-check/`, go to the **library** sheet and add a row:

   | title | path | icon | experience |
   |---|---|---|---|
   | Parity Check | `/tools/parity-check/parity-check.html?service=https://parity-check.<subdomain>.workers.dev&original=https://www.example.com` | `/tools/parity-check/icon.svg` | `inline` |

   - Use a **relative path** (starting with `/`). Workspace then loads the panel from this site's preview, so it can render the page you're editing.
   - `service=` is the capture Worker's address (from step 1). An author can also enter it in **Settings**.
   - `original=` is the original site's address (optional; otherwise it's learned from the first page you check). Add `prefix=/en` or `suffix=.html` if the original's paths differ that way.
   - If the site has no `library` sheet yet, add it with the **+** button next to the sheet tabs.
4. Save the config, reload Experience Workspace, open a page and choose **Parity Check** in the side-panel switcher.

**Testing a branch:** add a second row with `ref` set to the branch name, or open Workspace with `?ref=<branch>`. Push the branch first: the Worker reads that branch's capture code.

## Settings (gear icon)

- **Capture Worker address**, with a **Test** button: the Worker that runs Browserless for this site. Empty means the one in the library row. No key is ever entered in the panel: the Browserless key lives in the Worker as a secret.
- **Original site**, **path prefix**, **suffix**: where the originals of this site's pages are.
- **Ignore elements**: CSS selectors hidden on both pages before comparing (cookie banners are ignored by default).

## Demo

Open the panel address with `?demo`. It compares two sample pages with deliberate differences (font, button, image crop, columns, spacing, a missing section, an embed). Both are on this site, so the demo runs in the panel, with no capture Worker needed. Add `&cloud&service=<Worker address>` to capture the demo original with Browserless as well (on aem.page / aem.live, where Browserless can reach it).

## Limits

- **One page at a time.** The page you're editing, at every width you choose.
- **Browserless's free plan** gives 1,000 units a month (a unit is up to 30 s of browser time; one check of 2–4 widths usually takes one). Re-checks of a captured original are free.
- **The original must be public**, because Browserless opens it from the internet.
- **No pixel diff of this page.** It's rendered live rather than screenshotted, so the visual part of the score is the layout similarity of the matched elements (position and width).
- **A first pass, not a final verdict.** Carousels, tabs, accordions and personalised content can produce wrong issues. Approve intended differences and add noisy areas to **Ignore elements**.

## Files

```
tools/parity-check/
├── parity-check.html / .css / .js   # the panel
├── icon.svg
├── demo/                            # two sample pages with deliberate differences (from the PR)
└── lib/
    ├── extract.js, match.js, rules.js, words.js, prompt.js, breakpoints.js   # parity core, unchanged from the PR
    ├── cloud.js       # asks the capture Worker for the original
    ├── capture-fn.js  # the capture Browserless runs (every width, screenshots)
    ├── frame.js       # renders this page in the panel and reads it
    ├── compare.js     # one check, every width (like the PR's run.js)
    ├── visual.js      # side-by-side view with pins
    ├── report.js      # AEM Coder prompt and Markdown report
    ├── settings.js    # original address, widths, ignore list, approvals
    └── store.js       # browser storage (captured originals in IndexedDB)
worker/
    ├── capture-worker.js  # the Cloudflare Worker (paste into the dashboard)
    └── README.md          # setup, about 10 minutes
```

`worker/` is listed in the repository's `.hlxignore`, so the site doesn't serve it.
