import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { clonePage } from '../dist/clone.js';

const FIXTURE = pathToFileURL(resolve(import.meta.dirname, 'mosaic.html')).href;
const PNG_PREFIX = 'data:image/png;base64,';

/** Minimal PNG reader for the 16-cell RGBA/RGB mosaics the clone emits. */
function decodePng(dataUri) {
  if (!dataUri?.startsWith(PNG_PREFIX)) {
    throw new Error(`not a PNG data URI: ${String(dataUri).slice(0, 48)}`);
  }
  const bytes = Buffer.from(dataUri.slice(PNG_PREFIX.length), 'base64');
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('bad PNG signature');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colourType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const line = raw.subarray(start + 1, start + 1 + stride);
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[x] = value & 0xff;
    }
  }

  return {
    width,
    height,
    pixel(x, y) {
      const index = y * stride + x * channels;
      return [
        pixels[index],
        pixels[index + 1],
        pixels[index + 2],
        channels === 4 ? pixels[index + 3] : 255,
      ];
    },
  };
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function near(actual, expected, tolerance = 3) {
  return expected.every((value, index) => Math.abs(actual[index] - value) <= tolerance);
}

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const result = await clonePage({
  url: FIXTURE,
  viewport: { width: 1440, height: 900 },
  seed: 42,
  title: 'Mosaic fixture',
  images: 'mosaic',
  timeoutMs: 60_000,
});

const tags = result.html.match(/<img\b[^>]*>/gi) ?? [];
check(tags.length === 4, `expected 4 <img> elements, got ${tags.length}`);

const byId = new Map();
for (const tag of tags) byId.set(attribute(tag, 'id'), tag);

const mosaicIds = ['quad', 'wide', 'alpha'];
for (const id of mosaicIds) {
  const tag = byId.get(id);
  if (!tag) {
    failures.push(`missing #${id}`);
    continue;
  }
  const src = attribute(tag, 'src');
  const declared = attribute(tag, 'data-mosaic');
  try {
    const png = decodePng(src);
    check(
      declared === `${png.width}x${png.height}`,
      `#${id} data-mosaic="${declared}" but PNG is ${png.width}x${png.height}`,
    );
    check(
      attribute(tag, 'style') === null,
      `#${id} unexpectedly got an inline style`,
    );

    if (id === 'quad') {
      check(png.width === 16 && png.height === 16, `#quad expected 16x16, got ${png.width}x${png.height}`);
      check(near(png.pixel(3, 3), [225, 29, 72]), '#quad top-left is not red');
      check(near(png.pixel(12, 3), [22, 163, 74]), '#quad top-right is not green');
      check(near(png.pixel(3, 12), [37, 99, 235]), '#quad bottom-left is not blue');
      check(near(png.pixel(12, 12), [255, 255, 255]), '#quad bottom-right is not white');
    }

    if (id === 'wide') {
      check(png.width === 16 && png.height === 2, `#wide expected 16x2, got ${png.width}x${png.height}`);
      check(near(png.pixel(0, 0), [250, 204, 21]), '#wide left is not yellow');
      check(near(png.pixel(15, 0), [6, 182, 212]), '#wide right is not cyan');
    }

    if (id === 'alpha') {
      check(png.width === 16 && png.height === 16, `#alpha expected 16x16, got ${png.width}x${png.height}`);
      const centre = png.pixel(8, 8);
      check(near(centre, [217, 70, 239]), '#alpha centre is not magenta');
      check(centre[3] === 255, `#alpha centre should be opaque, alpha=${centre[3]}`);
      const corner = png.pixel(0, 0);
      check(corner[3] === 0, `#alpha corner should be transparent, alpha=${corner[3]}`);
    }
  } catch (error) {
    failures.push(`#${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const broken = byId.get('broken');
if (!broken) {
  failures.push('missing #broken');
} else {
  const src = attribute(broken, 'src') ?? '';
  check(
    src === 'https://placehold.co/120x80/d8d8d8/d8d8d8',
    `#broken expected a solid fallback, got ${src.slice(0, 64)}`,
  );
  check(attribute(broken, 'data-mosaic') === null, '#broken should not have a mosaic');
}

if (failures.length > 0) {
  process.stdout.write(`${failures.length} mosaic check(s) failed:\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('mosaic test: all checks passed\n');
}
