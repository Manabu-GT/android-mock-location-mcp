// ── Fetch utilities ──────────────────────────────────────────────────────────

/**
 * Fetch with an AbortController-based timeout.
 * Rejects with an AbortError if the request exceeds timeoutMs.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
