import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Token validation against the Keycloak realm, per the MCP authorization spec:
 * issuer + signature (JWKS) + expiry via jose's jwtVerify, audience binding
 * (RFC 8707 — the token must be minted for this resource, rejecting
 * pass-through of tokens issued for other services), then a required-scope
 * check on the standard space-separated `scope` claim.
 *
 * `jwks` is injectable for tests (createLocalJWKSet); production uses the
 * Keycloak realm's JWKS endpoint with jose's built-in caching/cooldown.
 */
export class TokenError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'TokenError';
    this.reason = reason;
  }
}

export function keycloakJwksUrl(issuer) {
  return new URL(`${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`);
}

export function createTokenVerifier({ issuer, audience, requiredScope, jwks }) {
  const keySet = jwks ?? createRemoteJWKSet(keycloakJwksUrl(issuer));

  return async function verifyToken(token) {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keySet, { issuer, audience }));
    } catch (err) {
      throw new TokenError(`token validation failed: ${err.code ?? err.message}`, 'invalid_token');
    }

    if (requiredScope) {
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      if (!scopes.includes(requiredScope)) {
        throw new TokenError(`missing required scope "${requiredScope}"`, 'insufficient_scope');
      }
    }

    return payload;
  };
}
