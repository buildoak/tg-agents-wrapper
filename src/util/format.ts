export function formatProgressBar(percentage: number, width = 10): string {
  const normalized = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((normalized / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}
