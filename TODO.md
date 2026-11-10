# TODO

## Next

- [ ] Multi-breakpoint capture (390 / 768 / 1440) and inference:
      - fixed px vs relative widths
      - grid tracks back to `fr`
      - media queries only where layout mode changes
- [ ] `--mode absolute` fallback for pages that reconstruct badly
- [ ] Drop fixed overlays (cookie banners, chat widgets, modals)
- [ ] Image placeholders tinted with the dominant brand color (`--sample-images`)
- [ ] Design tokens: emit `:root` palette, spacing scale, type scale
- [ ] Text bars mode (`--text bars`) as an alternative to lorem
- [ ] Collapse single-child wrapper divs
- [ ] Infer semantics for generic `div`s (`header`, `nav`, `main`, `h1`)

## Quality

- [ ] Verification pass: screenshot the output and diff against the original
- [ ] Unit tests for classification, grid inference, and flex sizing
- [ ] Fixture-based snapshot tests
- [ ] Commit a lockfile and pin the Docker image/package versions together

## Later

- [ ] JSON layout tree output
- [ ] React / Tailwind emitter
- [ ] Web UI
