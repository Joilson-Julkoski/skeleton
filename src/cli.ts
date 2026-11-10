#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { capture } from './capture.js';
import { emitHtml } from './emit.js';
import { buildLayout } from './extract.js';
import { makeRng } from './lorem.js';

const USAGE = `skeleton - turn a web page into an anonymized layout skeleton

Usage:
  skeleton <url> [options]

Options:
  -o, --out <file>        Output HTML file (default: out.html)
      --viewport <WxH>    Capture viewport (default: 1440x900)
      --seed <number>     Lorem seed (default: 42)
      --title <text>      Output page title (default: "Anonymized layout")
  -h, --help              Show this help

Examples:
  skeleton https://example.com -o out.html
  skeleton file:///test/fixture.html --viewport 1280x800
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o', default: 'out.html' },
      viewport: { type: 'string', default: '1440x900' },
      seed: { type: 'string', default: '42' },
      title: { type: 'string', default: 'Anonymized layout' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const url = positionals[0]!;
  const viewportArg = String(values.viewport);
  const [width, height] = viewportArg
    .split('x')
    .map((part) => Number.parseInt(part, 10));

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid --viewport "${viewportArg}". Expected WIDTHxHEIGHT, e.g. 1440x900.`);
  }

  const seed = Number.parseInt(String(values.seed), 10);
  if (!Number.isFinite(seed)) {
    throw new Error(`Invalid --seed "${values.seed}".`);
  }

  process.stderr.write(`Capturing ${url} at ${width}x${height}...\n`);
  const page = await capture({ url, viewport: { width, height } });
  if (!page.root) throw new Error('Could not extract a layout from this page.');

  const layout = buildLayout(page.root, makeRng(seed));
  const html = emitHtml(layout, {
    title: String(values.title),
    background: page.pageBackground,
  });

  const outPath = resolve(String(values.out));
  await writeFile(outPath, html, 'utf8');
  process.stderr.write(`Wrote ${outPath} (${(html.length / 1024).toFixed(1)} KB)\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
