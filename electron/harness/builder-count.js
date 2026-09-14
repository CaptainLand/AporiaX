export const MAX_BUILDERS = 4;
export const BUILDER_COUNT_CHOICES = [0, 2, 3, 4];
export const DEFAULT_BUILDER_LIMIT = 2;

export function normalizeBuilderCount(value, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  if (number === 1) return 2;
  return Math.min(MAX_BUILDERS, Math.max(2, Math.floor(number)));
}
