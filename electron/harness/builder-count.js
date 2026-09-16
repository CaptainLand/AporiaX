export const MAX_BUILDERS = 6;
export const BUILDER_COUNT_CHOICES = [0, 1, 2, 3, 4, 6];
export const DEFAULT_BUILDER_LIMIT = 2;

export function normalizeBuilderCount(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  return Math.min(MAX_BUILDERS, Math.max(1, Math.floor(number)));
}
