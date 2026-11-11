import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clonePage } from '../dist/clone.js';

const FIXTURE = pathToFileURL(resolve(import.meta.dirname, 'anonymize.html')).href;

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const result = await clonePage({
  url: FIXTURE,
  viewport: { width: 1440, height: 900 },
  seed: 42,
  title: 'Anonymize fixture',
  timeoutMs: 60_000,
});

const html = result.html;

// Original names must be gone from markup and CSS.
for (const name of [
  'theme-body',
  'page-header',
  'brand-logo',
  'nav-link',
  'is-active',
  'ghost-card',
  'kept-never',
  'kept-alias',
  'dead-alias',
  'missing-thing',
  'hero-panel',
  'email-field',
  'unused-widget',
  'unused-panel',
  'never-matches',
]) {
  check(!html.includes(name), `original name "${name}" leaked into the output`);
}

// Every surviving class/id should use the generic names.
const classValues = [...html.matchAll(/\bclass="([^"]*)"/g)].flatMap((match) =>
  match[1].split(/\s+/).filter(Boolean),
);
check(classValues.length >= 5, `expected several classes, got ${classValues.length}`);
for (const value of classValues) {
  check(/^c\d+$/.test(value), `unexpected class name "${value}"`);
}

const idValues = [...html.matchAll(/\bid="([^"]*)"/g)].map((match) => match[1]);
check(idValues.length >= 2, `expected at least two ids, got ${idValues.length}`);
for (const value of idValues) {
  check(/^i\d+$/.test(value), `unexpected id "${value}"`);
}

// body class must be renamed both in the attribute and in its selector.
const bodyTag = html.match(/<body\b[^>]*>/i)?.[0] ?? '';
const bodyClass = bodyTag.match(/\bclass="([^"]*)"/)?.[1] ?? '';
check(/^c\d+$/.test(bodyClass), `body class was not renamed: "${bodyClass}"`);
check(
  new RegExp(`body\\.${bodyClass}\\b`).test(html),
  `body selector for .${bodyClass} missing from CSS`,
);

// References to renamed ids follow the rename.
const labelFor = html.match(/<label\b[^>]*\bfor="([^"]+)"/i)?.[1] ?? '';
const inputId = html.match(/<input\b[^>]*\bid="([^"]+)"/i)?.[1] ?? '';
check(labelFor !== '', 'label lost its for attribute');
check(
  labelFor === inputId,
  `label for="${labelFor}" does not match input id="${inputId}"`,
);

// Unused rules are pruned, in the base sheet and inside @media.
check(!html.includes('color: red'), 'unused rules were not pruned');
check(!html.includes('unused'), 'unused selectors survived');
check(html.includes('@media (min-width: 1px)'), 'used @media block was dropped');
check(/padding:\s*12px/.test(html), 'used @media rule was dropped');
check(/font-weight:\s*700/.test(html), 'used compound selector was dropped');
check(html.includes('::before'), 'used pseudo-element rule was dropped');
check(html.includes('@keyframes pulse'), 'keyframes were dropped');
check(html.includes('border-top'), 'used branch of a selector list was dropped');
check(!html.includes(':not('), ':not() with a missing class was not cleaned up');

// Behavioral/structural rules survive.
check(html.includes('border-bottom'), 'used structural rule was dropped');
check(/<a\b[^>]*\bhref="#"/.test(html), 'links were not neutralized');
check(!html.includes('brand.example'), 'original link leaked into the output');

// The opt-out keeps the original names and the full stylesheet.
const kept = await clonePage({
  url: FIXTURE,
  viewport: { width: 1440, height: 900 },
  seed: 42,
  title: 'Anonymize fixture',
  anonymize: false,
  timeoutMs: 60_000,
});
check(kept.html.includes('theme-body'), 'keep-names lost the body class');
check(kept.html.includes('page-header'), 'keep-names lost a class name');
check(kept.html.includes('unused-widget'), 'keep-names pruned unused CSS');

if (failures.length > 0) {
  process.stdout.write(`${failures.length} anonymize check(s) failed:\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('anonymize test: all checks passed\n');
}