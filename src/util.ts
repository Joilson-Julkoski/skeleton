export function isNonZero(value: string | undefined | null): boolean {
  if (!value) return false;
  if (value === 'auto') return true;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed !== 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
