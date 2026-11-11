# TODO

## Next

- [ ] Rename custom properties, keyframes and counter names too (class/id names
      are already generic).
- [ ] Strip `data-*`/ARIA attributes that only survived because a now-pruned
      CSS rule referenced them.
- [ ] Computed-style emitter (the anonymized middle ground): walk the live DOM,
      emit a curated computed-style subset per element instead of the page's
      stylesheet. Target the same fidelity without borrowed CSS.
- [x] Regenerate class names and ids, rewrite selectors to match.
- [ ] `--assets inline`: inline images/fonts as data URIs for a self-contained
      file (accept the size).
- [ ] Freeze time and animations so carousels and rotating heroes are
      deterministic across reruns.
- [ ] `--wait <selector>` / `--wait-ms` escape hatches for slow hydration.
- [ ] Clone open shadow roots instead of light DOM only.
- [ ] Robust `srcset` parser (commas inside `data:` URIs).
- [ ] Drop fixed overlays (cookie banners, chat widgets, modals).
- [x] Prune CSS rules that match nothing in the cloned DOM.

## Quality

- [x] Verification pass: screenshot the output and diff against the original
      (`test/suite.mjs` now derives verdicts from the measured diff).
- [ ] Mask text regions in the diff so the score measures layout, not lorem.
- [ ] Fixture tests for the inlining and clone passes: `file://` stylesheets,
      `@import`, `srcset`, cross-origin sheets, late-injected `<link>`.
- [ ] Typecheck + fixture run in CI.
- [x] Commit a lockfile and pin the Docker image/package versions together.

## Later

- [ ] JSON DOM output
- [ ] React / Tailwind emitter
- [ ] Web UI
