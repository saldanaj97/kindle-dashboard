import { exports } from "cloudflare:workers";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { accessConfig, checkAccess, verifyAccessToken, type AccessConfig } from "../src/access";

const config: AccessConfig = { teamDomain: "https://example-team.cloudflareaccess.com", aud: "test-aud-tag" };

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  otherPrivateKey = other.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

function token(
  claims: { iss?: string; aud?: string | string[]; expiresIn?: string | number } = {},
  key: CryptoKey = privateKey,
): Promise<string> {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? config.teamDomain)
    .setAudience(claims.aud ?? [config.aud])
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? "5m")
    .sign(key);
}

describe("verifyAccessToken", () => {
  it("accepts a token signed by Access for this application", async () => {
    expect(await verifyAccessToken(await token(), config, keys)).toEqual({ ok: true });
  });

  it.each([
    ["another application's audience", { aud: ["other-aud"] }],
    ["another team's issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["an expired token", { expiresIn: Math.floor(Date.now() / 1000) - 3600 }],
  ])("rejects %s", async (_label, claims) => {
    expect(await verifyAccessToken(await token(claims), config, keys)).toEqual({
      ok: false,
      reason: "invalid access token",
    });
  });

  it("rejects a token without an expiry", async () => {
    const noExp = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(config.teamDomain)
      .setAudience([config.aud])
      .setIssuedAt()
      .sign(privateKey);
    expect((await verifyAccessToken(noExp, config, keys)).ok).toBe(false);
  });

  it("accepts the audience as a plain string too", async () => {
    expect((await verifyAccessToken(await token({ aud: config.aud }), config, keys)).ok).toBe(true);
  });

  it("rejects a token signed with a different key", async () => {
    expect((await verifyAccessToken(await token({}, otherPrivateKey), config, keys)).ok).toBe(false);
  });

  it("rejects an unsigned token and garbage", async () => {
    const header = btoa(JSON.stringify({ alg: "none", kid: "k1" })).replace(/=+$/, "");
    const body = btoa(JSON.stringify({ iss: config.teamDomain, aud: [config.aud], exp: 9999999999 })).replace(/=+$/, "");
    expect((await verifyAccessToken(`${header}.${body}.`, config, keys)).ok).toBe(false);
    expect((await verifyAccessToken("not-a-jwt", config, keys)).ok).toBe(false);
  });
});

describe("accessConfig", () => {
  it("needs both values and an https team domain", () => {
    expect(accessConfig({})).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: config.teamDomain })).toBeNull();
    expect(accessConfig({ ACCESS_AUD: "x" })).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: "http://example-team.cloudflareaccess.com", ACCESS_AUD: "x" })).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: `${config.teamDomain}/`, ACCESS_AUD: " test-aud-tag " })).toEqual(config);
  });
});

describe("checkAccess", () => {
  const configured = { ACCESS_TEAM_DOMAIN: config.teamDomain, ACCESS_AUD: config.aud };

  it("the dev bypass works only on local hostnames", async () => {
    for (const host of ["localhost", "127.0.0.1", "dashboard.test"]) {
      expect(await checkAccess(new Request(`https://${host}/screen/x.png`), { ACCESS_DEV_BYPASS: "1" })).toEqual({ ok: true });
    }
    expect(
      await checkAccess(new Request("https://kindle.juansaldana.dev/screen/x.png"), { ACCESS_DEV_BYPASS: "1" }),
    ).toEqual({ ok: false, reason: "access is not configured" });
    for (const value of ["true", "yes", " 1"]) {
      expect(
        await checkAccess(new Request("https://localhost/screen/x.png"), { ACCESS_DEV_BYPASS: value }),
      ).toEqual({ ok: false, reason: "access is not configured" });
    }
  });

  it("fails closed when Access is not configured", async () => {
    expect(await checkAccess(new Request("https://localhost/screen/x.png"), {})).toEqual({
      ok: false,
      reason: "access is not configured",
    });
  });

  it("requires the Access JWT header when configured", async () => {
    expect(await checkAccess(new Request("https://kindle.juansaldana.dev/screen/x.png"), configured)).toEqual({
      ok: false,
      reason: "missing access token",
    });
  });
});

describe("screen route on the real hostname", () => {
  it("answers a generic 403 without a valid Access JWT, even for unknown screens and HEAD", async () => {
    for (const path of ["/screen/trade-plans.png", "/screen/market-summary.png", "/screen/nope.png"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await exports.default.fetch(new Request(`https://kindle.juansaldana.dev${path}`, { method }));
        expect(res.status).toBe(403);
        if (method === "GET") expect(await res.json()).toEqual({ error: "forbidden" });
      }
    }
    const bad = await exports.default.fetch(
      new Request("https://kindle.juansaldana.dev/screen/trade-plans.png", {
        headers: { "cf-access-jwt-assertion": "not-a-jwt" },
      }),
    );
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ error: "forbidden" });
  });

  it("other methods get 405 and no data", async () => {
    const res = await exports.default.fetch(
      new Request("https://kindle.juansaldana.dev/screen/trade-plans.png", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(405);
  });

  it("still serves screens on local hosts under the dev bypass", async () => {
    const res = await exports.default.fetch(new Request("https://dashboard.test/screen/trade-plans.png"));
    expect(res.status).toBe(200);
  });
});
