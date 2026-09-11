// Preserve explicit task choices; new/legacy tasks without a choice use Direct.
export function taskExecutionMode(value) {
  return ["direct", "safe", "isolated"].includes(value) ? value : "direct";
}
