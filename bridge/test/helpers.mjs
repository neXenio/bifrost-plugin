import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';

export const ISSUER = 'https://keycloak.example.test/realms/mcp';
export const ORIGIN = 'https://bifrost.example.test';

export async function makeTestKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

export async function signToken(privateKey, {
  issuer = ISSUER,
  audience = ORIGIN,
  scope = 'mcp:read',
  email = 'alice@luca-app.de',
  sub = 'sub-alice',
  expiresIn = '5m',
  kid = 'test-key',
} = {}) {
  let jwt = new SignJWT({ scope, email })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt();
  jwt = expiresIn.startsWith('-')
    ? jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    : jwt.setExpirationTime(expiresIn);
  return jwt.sign(privateKey);
}
