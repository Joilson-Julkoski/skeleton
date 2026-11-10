export type Rng = () => number;

const WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
  'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia',
  'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum',
];

/** Small deterministic PRNG so reruns with the same seed produce the same lorem. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates lorem with roughly the same word count as the original text.
 * Matching the count keeps line wrapping (and therefore height) close to the source.
 */
export function loremFor(original: string, rng: Rng): string {
  const wordCount = original.trim().split(/\s+/).filter(Boolean).length;
  const count = Math.max(1, Math.min(wordCount, 80));
  const words: string[] = [];
  for (let index = 0; index < count; index += 1) {
    words.push(WORDS[Math.floor(rng() * WORDS.length)]);
  }
  const first = words[0];
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return `${words.join(' ')}.`;
}
