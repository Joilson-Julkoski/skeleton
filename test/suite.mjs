import { mkdir, writeFile } from 'node:fs/promises';
import { clonePage } from '../dist/clone.js';

const OUT = process.env.OUT_DIR ?? '/out/tests';
const IMAGE_MODE = process.env.IMAGE_MODE === 'mosaic' ? 'mosaic' : 'solid';
const VIEWPORT = { width: 1440, height: 900 };
const SEED = 42;

const PAGES = [
  { slug: 'wikipedia', name: 'Wikipedia — Web browser', tier: 1, url: 'https://en.wikipedia.org/wiki/Web_browser' },
  { slug: 'hackernews', name: 'Hacker News', tier: 1, url: 'https://news.ycombinator.com' },
  { slug: 'bbc', name: 'BBC News', tier: 2, url: 'https://www.bbc.com/news' },
  { slug: 'github', name: 'GitHub — VS Code repo', tier: 3, url: 'https://github.com/microsoft/vscode' },
  { slug: 'apple', name: 'Apple', tier: 3, url: 'https://www.apple.com/' },
];

async function main() {
  await mkdir(OUT, { recursive: true });

  const failures = [];
  let captured = 0;

  for (const entry of PAGES) {
    const started = Date.now();

    try {
      process.stdout.write(`[${entry.slug}] capturing ${entry.url}\n`);
      const clone = await clonePage({
        url: entry.url,
        viewport: VIEWPORT,
        seed: SEED,
        title: 'Placeholder clone',
        images: IMAGE_MODE,
        timeoutMs: 90_000,
      });

      await writeFile(`${OUT}/${entry.slug}.html`, clone.html, 'utf8');
      captured += 1;
      process.stdout.write(
        `[${entry.slug}] ${IMAGE_MODE} ok — ${(Buffer.byteLength(clone.html) / 1024).toFixed(1)} KB, ` +
        `${clone.elementCount} elements, ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ slug: entry.slug, message });
      process.stdout.write(`[${entry.slug}] FAILED — ${message}\n`);
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length}/${PAGES.length} page(s) failed:\n`);
    for (const failure of failures) {
      process.stdout.write(`  - ${failure.slug}: ${failure.message}\n`);
    }
  }

  process.stdout.write(`\nDone — ${captured}/${PAGES.length} clones written to ${OUT}\n`);

  // A partial run still deploys the clones that worked; only a total failure
  // should turn the job red.
  if (captured === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
