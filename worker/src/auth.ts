const encoder = new TextEncoder();

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/**
 * Compares a presented secret with the expected one in constant time.
 * Both sides are hashed first so the comparison never depends on length.
 * An empty or missing expected secret never matches.
 */
export async function secretMatches(presented: string | null, expected: string | undefined): Promise<boolean> {
  if (!presented || !expected) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Reads `Authorization: Bearer <secret>`; returns null when absent or malformed. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1]! : null;
}
