const keys = input => {
  if (!Array.isArray(input) || input.length > 20 || input.some(key => typeof key !== 'string' || key.length > 200 || ['__proto__', 'prototype', 'constructor'].includes(key))) throw Error('NUMERIC_INVALID_KEYS');
  return [...input];
};
export function normalizeNumericCheck(input) {
  if (!input || !['sum', 'count'].includes(input.operation)) throw Error('NUMERIC_INVALID_OPERATION');
  const out = { operation: input.operation, rows: keys(input.rows ?? []) };
  if (input.operation === 'sum') out.field = keys(input.field ?? []);
  if (input.expectedKeys !== undefined) out.expectedKeys = keys(input.expectedKeys);
  else if (typeof input.expected === 'number' && Number.isFinite(input.expected) && Math.abs(input.expected) <= Number.MAX_SAFE_INTEGER) out.expected = input.expected;
  else throw Error('NUMERIC_EXPECTED_REQUIRED');
  if (input.expectedKeys !== undefined && input.expected !== undefined) throw Error('NUMERIC_AMBIGUOUS_EXPECTED');
  out.tolerance = input.tolerance ?? 0;
  if (typeof out.tolerance !== 'number' || !Number.isFinite(out.tolerance) || out.tolerance < 0 || out.tolerance > 1) throw Error('NUMERIC_INVALID_TOLERANCE');
  return out;
}
const at = (value, path) => path.reduce((item, key) => item != null && Object.hasOwn(item, key) ? item[key] : undefined, value);
export function evaluateNumericData(data, input) {
  const check = normalizeNumericCheck(input);
  const rows = at(data, check.rows);
  if (!Array.isArray(rows) || rows.length > 100000) throw Error('NUMERIC_ROWS_REQUIRED_OR_TOO_LARGE');
  const expected = check.expectedKeys ? at(data, check.expectedKeys) : check.expected;
  if (typeof expected !== 'number' || !Number.isFinite(expected) || Math.abs(expected) > Number.MAX_SAFE_INTEGER) throw Error('NUMERIC_INVALID_EXPECTED');
  let actual = rows.length;
  if (check.operation === 'sum') {
    actual = 0; let correction = 0;
    for (const [index, row] of rows.entries()) {
      const value = at(row, check.field);
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw Error(`NUMERIC_INVALID_VALUE: row ${index}`);
      const next = value - correction, total = actual + next;
      correction = (total - actual) - next; actual = total;
      if (!Number.isFinite(actual) || Math.abs(actual) > Number.MAX_SAFE_INTEGER) throw Error('NUMERIC_OVERFLOW');
    }
  }
  const passed = Math.abs(actual - expected) <= check.tolerance;
  return { kind: 'numeric-check', passed, actual, expected, rows: rows.length, check,
    scope: 'Recomputed from these exact file bytes; does not certify the source data or untested formulas.' };
}
const jsonKeys = { type: 'array', items: { type: 'string' }, maxItems: 20 };
export const NUMERIC_CHECK_TOOL = { type: 'function', function: {
  name: 'verify_numeric_data', description: 'Recompute a JSON array sum/count without scripts. Returns actual/expected, pass/fail, input hash and replayable check. Checks saved bytes, not source authenticity. Use for numerical equality claims.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, operation: { type: 'string', enum: ['sum', 'count'] }, rows: jsonKeys, field: jsonKeys, expected: { type: 'number' }, expectedKeys: jsonKeys, tolerance: { type: 'number', minimum: 0, maximum: 1 } }, required: ['path', 'operation'], additionalProperties: false },
} };
