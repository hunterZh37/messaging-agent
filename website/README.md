# Landing page

A single self-contained static page (`index.html` + `assets/`) — no build step, no
framework. Deliberately kept separate from the app in `apps/` so it can be hosted on its
own domain independently of the product.

## Preview locally

```bash
open website/index.html
# or: npx serve website
```

## Deploy

Any static host works:

- **Vercel** — new project, set "Root Directory" to `website/`, framework preset "Other".
  No build command needed.
- **GitHub Pages** — Settings → Pages → Deploy from a branch → `main` / `/website`.
- **Netlify** — drag the `website/` folder in, or point a site at this repo with the base
  directory set to `website/`.

## Before you publish

- Deployed at <https://celeste-landing-pi.vercel.app> (Vercel project
  `celeste-landing`, scope `hunter-1247s-projects`, root directory `website/`).
  The plain `celeste-landing.vercel.app` was already taken by someone else, hence
  the suffix; the `og:` and `twitter:` tags must match whatever domain it serves
  from or the social card 404s.
- Every link points at `github.com/hunterZh37/messaging-agent`. If the repo lands under a
  different name, search and replace it here and in the meta tags.
- `assets/og.png` is the social preview card, 1200×630 at 2×. Its source is
  `assets/og-source.html`; regenerate it whenever the headline changes:

  ```bash
  npx serve website &
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --screenshot=website/assets/og.png --window-size=1200,630 \
    http://127.0.0.1:3000/assets/og-source.html
  ```
- The "Why" section is written in the first person. It is the one part of this page nobody
  else can write for you — read it and make it yours.
- `assets/flow.png` is the "everything in one place" diagram, 1600×700 at 2×.
  Its source is `assets/flow-source.html`; regenerate it when the wording or
  the sources change:

  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --screenshot=website/assets/flow.png --window-size=1600,700 \
    website/assets/flow-source.html
  ```

  It uses the page's own palette, so the two cannot drift apart.
- `assets/handover.png` is the Scheduling Agent pipeline, 1600×530 at 2×, from
  `assets/handover-source.html`. Every name in it is real — `create_actionable`,
  `get_availability`, the JSON-RPC shape — so if any of those change in
  `packages/core/src/alex/`, this changes with them.
- The four feature pictures are `assets/sorting.png` (1440×430),
  `assets/projects.png` (1440×330), `assets/drafting.png` (1440×380) and
  `assets/ask.png` (1440×330). Each has a `-source.html` beside it and they all
  share `assets/diagram.css`, so eight diagrams cannot drift into eight looks.
  Regenerate one with its own height:

  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --screenshot=website/assets/sorting.png --window-size=1440,430 \
    website/assets/sorting-source.html
  ```
- `assets/motivation.png` (1440×420) is the problem the app exists for, from
  `assets/motivation-source.html`. It belongs beside the motivation text on
  both the page and the README, so if that text changes, check this still
  agrees with it.

## Every picture is rendered twice

Each `*-source.html` produces a `-light.png` and a `-dark.png`, and the README
and the page reference them through a `<picture>` element so GitHub and the
browser pick by the reader's theme. The dark palette lives in
`assets/diagram.css` under `html[data-theme="dark"]`, and the two older
sources carry their own copy of it.

Render both by copying the source with the attribute set, rather than relying
on the `?dark` helper in each file, which headless Chrome does not run before
it captures:

```bash
sed 's/<html /<html data-theme="dark" /' assets/sorting-source.html > /tmp/d.html
```

A new diagram needs both files, or it will be a bright slab for half the
people who open it.
