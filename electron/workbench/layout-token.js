export function acceptLayoutGeneration(incoming, accepted = 0) {
  const generation = Number(incoming);
  if (!Number.isFinite(generation)) return { apply: true, accepted: Number(accepted) || 0 };
  const current = Number(accepted) || 0;
  if (generation < current) return { apply: false, accepted: current };
  return { apply: true, accepted: generation };
}
