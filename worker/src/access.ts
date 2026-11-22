import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Screens sit behind Cloudflare Access (standing rule 4). Access adds a signed
// JWT to every request it lets through; the Worker verifies it too, so a
// misconfigured Access application (wrong path, policy detached) blocks the
// screens instead of exposing them. Fails closed: missing config is a 403.

/** Hostnames where ACCESS_DEV_BYPASS may skip the check: local dev and tests. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "dashboard.test"]);

export interface AccessConfig {
  /** https://<team>.cloudflareaccess.com — the JWT issuer and where the signing keys live. */
  teamDomain: string;
  /** The Access application's Application Audience (AUD) tag. */
  aud: string;
}

export type AccessResult = { ok: true } | { ok: false; reason: string };

// One key set per team domain, kept for the isolate's lifetime. jose caches the
// keys and refetches when it meets an unknown key id (Access rotates keys).
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function keysFor(teamDomain: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    remoteKeySets.set(teamDomain, keys);
  }
  return keys;
}

/** Reads and checks the Access settings; null when they are missing or not https. */
export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): AccessConfig | null {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/+$/, "");
  const aud = (env.ACCESS_AUD ?? "").trim();
  if (!teamDomain || !aud) return null;
  try {
    if (new URL(teamDomain).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { teamDomain, aud };
}

/** Verifies one Access JWT: signature, expiry, issuer and audience. */
export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  keys: JWTVerifyGetKey = keysFor(config.teamDomain),
): Promise<AccessResult> {
  try {
    await jwtVerify(token, keys, {
      issuer: config.teamDomain,
      audience: config.aud,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
      clockTolerance: 60,
    });
    return { ok: true };
  } catch (err) {
    // Log the failure class (bad signature, expired, JWKS fetch failed) so an
    // Access outage is distinguishable from bad credentials. Never log the token.
    const code = (err as { code?: string }).code ?? (err as Error).name ?? "unknown";
    console.warn(`access: token rejected (${code})`);
    return { ok: false, reason: "invalid access token" };
  }
}

/** The check for a screen request. */
export async function checkAccess(
  request: Request,
  env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; ACCESS_DEV_BYPASS?: string },
): Promise<AccessResult> {
  const { hostname } = new URL(request.url);
  if (env.ACCESS_DEV_BYPASS === "1" && LOCAL_HOSTS.has(hostname)) return { ok: true };

  const config = accessConfig(env);
  if (!config) return { ok: false, reason: "access is not configured" };

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, reason: "missing access token" };
  return verifyAccessToken(token, config);
}
