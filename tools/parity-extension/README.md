# Parity Check for AEM (browser extension)

A Chrome / Edge side-panel extension that compares **the page you have open** (the migrated AEM Edge Delivery Services page) with its **original page**, and shows every visible difference as numbered pins on the page. A **Google PageSpeed Insights** (Lighthouse) comparison shows which accessibility, SEO, best-practice and performance checks the migration broke.

It is the in-browser version of [`tools/parity-check`](https://github.com/ShivaniM123/parity-check/pull/1) and uses the same parity rules. There is nothing to install or run besides the extension, and it checks one page only: the one you are looking at.

## Why authors use it

After a page is migrated, an author has to answer: *does it look like the original, and is it at least as good?* Without a tool this means flipping between two tabs and guessing. With the extension:

1. Open the migrated page (aem.page, aem.live or the local preview) and click the toolbar icon.
2. The original page is filled in (after the first page of a site, the address is worked out for you). Click **Check this page**.
3. About 10 seconds later: a parity score, High / Medium / Low issues and pins on the page. Click a pin or an issue to see the original and migrated values side by side.
4. Mark each issue **Approve** (intended) or **Needs fix**, then **Copy for AEM Coder** or **Download report**.

## Features

**Visual parity (the page you have open)**
* Compares at the width you are viewing. The original opens for a few seconds in a window of exactly the same viewport width, then closes.
* Checks from the parity-check rules: missing, extra or reworded content (exact words, e.g. *"hosts" → "host"*), columns per row, spacing, font family, size, weight, line height, letter spacing, casing, alignment, colours, buttons, image size and crop, horizontal scrolling, page height, failed fonts and requests, social embeds.
* Content is matched by what it says, not where it sits, so moved or rebuilt sections aren't reported as missing.
* Lists the original's breakpoints and tells you which ones the migrated CSS doesn't have. To check another layout, resize the window and check again.
* Pins on the page (shadow DOM, so they never inherit page styles). Clicking a pin opens its issue in the panel; dashed boxes show where missing content should be.
* Keyboard: `←` `→` move between issues, `A` approve, `F` needs fix, `Esc` close.

**Lighthouse comparison (Google PageSpeed Insights)**
* Runs Lighthouse on Google's servers for both pages at the same time: scores for Performance, Accessibility, Best Practices and SEO (original → migrated).
* **Got worse after migration**: every check that passes on the original and fails on the migrated page, with the elements Lighthouse names. **Show** outlines that element on the open page.
* Lab metrics (LCP, CLS, TBT, FCP, Speed Index), with slower metrics marked, plus checks the migration fixed.
* Only for public pages (aem.page / aem.live, not localhost). The panel says so when a page isn't public.

**Hand-off**
* **Copy for AEM Coder**: a ready prompt with the open (not approved) issues, values and widths, plus the Lighthouse regressions.
* **Download report**: a Markdown report with every issue, its status and the Lighthouse results.
* Results and approvals are kept per page, so re-opening the panel shows the last check.

## Install (developer mode)

1. Get this folder (`tools/parity-extension/`) on your computer, for example by downloading the repository as a ZIP from GitHub.
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and select the `parity-extension` folder.
3. Pin **Parity Check** to the toolbar. Shortcut: `Alt` + `Shift` + `P`.

## Settings

Open them from the gear icon in the panel.

* **PageSpeed Insights API key (optional, recommended).** The API works without a key, but the shared quota is often used up. In practice you need a free key: in Google Cloud, enable *PageSpeed Insights API* and create an API key (25,000 tests a day). The key is stored in the browser's extension storage only.
* **Run Lighthouse with every check**, and **Device** (match my view, mobile or desktop).
* **Ignore elements**: CSS selectors hidden on both pages before comparing (cookie banners are ignored by default).
* **Site mappings**: where the original of each migrated site lives (origin, path prefix such as `/en`, suffix such as `.html`). They're learned from the first page you check, and all branches of an EDS site (`*--site--org.aem.page/.live`) share one mapping.

## Files

```
tools/parity-extension/
├── manifest.json        # MV3: side panel, scripting, tabs, storage
├── background.js        # Opens the side panel from the toolbar button
├── sidepanel/           # The panel UI (panel.html / .css / .js)
├── options/             # Settings page
├── icons/
└── lib/
    ├── check.js         # One check: read the open page, open + read the original, compare
    ├── page.js          # Functions injected into pages: state, settle, pins, highlight
    ├── psi.js           # Google PageSpeed Insights client and Lighthouse comparison
    ├── settings.js      # Settings and original-URL mapping
    ├── report.js        # AEM Coder prompt + Markdown report
    └── extract.js, match.js, rules.js, words.js, prompt.js, breakpoints.js
                         # Parity engine, copied unchanged from tools/parity-check
```

The folder is listed in `.hlxignore`, so Edge Delivery doesn't serve it.

## Points to note

* **One page, one width.** The extension checks only the open page at its current width. For lists of pages or many widths at once, use `tools/parity-check`.
* **No pixel diff.** Screenshots aren't compared. The visual part of the score is the layout similarity of the matched elements (position and width), so scores can differ a little from `tools/parity-check`.
* **Narrow widths**: browsers have a minimum window width (about 500px). If the original can't be opened at your width, the panel tells you.
* **A first pass, not a final verdict.** Carousels, tabs, accordions and personalised content can produce wrong issues. Approve intended differences and add noisy areas to **Ignore elements**.
* **Lighthouse scores vary between runs**, especially Performance. The checks that fail are more reliable than small score changes.
