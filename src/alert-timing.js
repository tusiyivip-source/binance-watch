/** Keep exchange event time separate from discovery time (including startup catch-up). */
export function alertTiming(confirmedAt, detectedAt, initial = false) {
  const delayMs = Number.isFinite(confirmedAt) ? Math.max(0, detectedAt - confirmedAt) : null;
  const historical = !!initial || (delayMs !== null && delayMs > 90_000);
  return { confirmedAt, detectedAt, delayMs, historical, initial: historical };
}
