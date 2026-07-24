import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenVerifier, TokenError } from '../src/auth.mjs';
import { makeTestKeys, signToken, ISSUER, ORIGIN } from './helpers.mjs';

const { privateKey, jwks } = await makeTestKeys();
const verify = createTokenVerifier({
  issuer: ISSUER,
  audience: ORIGIN,
  requiredScope: 'mcp:read',
  jwks,
});

async function assertRejects(token, reason) {
  await assert.rejects(verify(token), (err) => {
    assert.ok(err instanceof TokenError, `expected TokenError, got ${err}`);
    assert.equal(err.reason, reason);
    return true;
  });
}

test('valid token returns claims', async () => {
  const payload = await verify(await signToken(privateKey));
  assert.equal(payload.email, 'alice@luca-app.de');
  assert.equal(payload.sub, 'sub-alice');
});

test('expired token is rejected', async () => {
  await assertRejects(await signToken(privateKey, { expiresIn: '-1m' }), 'invalid_token');
});

test('wrong issuer is rejected', async () => {
  await assertRejects(
    await signToken(privateKey, { issuer: 'https://evil.example.test/realms/mcp' }),
    'invalid_token',
  );
});

test('cross-audience token is rejected (RFC 8707 audience binding)', async () => {
  await assertRejects(
    await signToken(privateKey, { audience: 'https://some-other-service.example.test' }),
    'invalid_token',
  );
});

test('token signed by an unknown key is rejected', async () => {
  const { privateKey: otherKey } = await makeTestKeys();
  await assertRejects(await signToken(otherKey), 'invalid_token');
});

test('missing required scope is rejected as insufficient_scope', async () => {
  await assertRejects(await signToken(privateKey, { scope: 'openid profile' }), 'insufficient_scope');
});
