import Fastify from 'fastify';
import httpProxy from '@fastify/http-proxy';
import { createTokenVerifier, TokenError } from './auth.mjs';
import { createVkMap } from './vk-map.mjs';
import { buildProtectedResourceMetadata, wwwAuthenticateValue } from './metadata.mjs';

const DEFAULT_SCOPES = ['mcp:read', 'mcp:write'];

export function loadConfigFromEnv(env = process.env) {
  const required = ['BRIDGE_PUBLIC_ORIGIN', 'BRIDGE_UPSTREAM_URL', 'KEYCLOAK_ISSUER', 'VK_MAP_PATH'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`missing required env vars: ${missing.join(', ')}`);
  }
  return {
    publicOrigin: env.BRIDGE_PUBLIC_ORIGIN.replace(/\/$/, ''),
    upstreamUrl: env.BRIDGE_UPSTREAM_URL,
    keycloakIssuer: env.KEYCLOAK_ISSUER.replace(/\/$/, ''),
    requiredScope: env.BRIDGE_REQUIRED_SCOPE ?? 'mcp:read',
    vkMapPath: env.VK_MAP_PATH,
    port: Number(env.PORT ?? 8787),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

export function buildServer(config, { jwks } = {}) {
  const app = Fastify({
    logger: {
      level: config.logLevel ?? 'info',
      // Credentials must never reach the logs.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-bf-vk"]',
          'req.headers["x-api-key"]',
        ],
        censor: '[redacted]',
      },
    },
  });

  const verifyToken = createTokenVerifier({
    issuer: config.keycloakIssuer,
    audience: config.publicOrigin,
    requiredScope: config.requiredScope,
    jwks,
  });
  const vkMap = createVkMap(config.vkMapPath, { logger: app.log });
  app.addHook('onClose', async () => vkMap.close());

  const prm = buildProtectedResourceMetadata({
    publicOrigin: config.publicOrigin,
    authorizationServer: config.keycloakIssuer,
    scopes: DEFAULT_SCOPES,
  });
  // RFC 9728 well-known document, plus the path-suffixed variant for the
  // /mcp resource path. Both return the same document.
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    app.get(path, async () => prm);
  }

  app.get('/healthz', async () => ({ ok: true, vkMapEntries: vkMap.size() }));

  function unauthorized(reply, error, message) {
    return reply
      .code(error === 'insufficient_scope' ? 403 : 401)
      .header('WWW-Authenticate', wwwAuthenticateValue(config.publicOrigin, error))
      .send({ error: error ?? 'unauthorized', error_description: message });
  }

  app.register(httpProxy, {
    upstream: config.upstreamUrl,
    prefix: '/',
    replyOptions: {
      rewriteRequestHeaders(request, headers) {
        if (!request.bridgeVk) return headers;
        // OAuth-authenticated request: inject the mapped virtual key and
        // strip the inbound Bearer so it is never forwarded upstream.
        const rewritten = { ...headers, 'x-bf-vk': request.bridgeVk };
        delete rewritten.authorization;
        return rewritten;
      },
    },
    async preHandler(request, reply) {
      if (!request.raw.url.startsWith('/mcp')) return;

      // Existing virtual-key path (Claude Code CLI): forward as-is.
      if (request.headers['x-bf-vk'] || request.headers['x-api-key']) return;

      const authHeader = request.headers.authorization ?? '';
      if (!authHeader.startsWith('Bearer ')) {
        // The resource_metadata pointer here is what turns Desktop's
        // mcp_registration_failed into OAuth discovery.
        return unauthorized(reply, undefined, 'authentication required');
      }

      let claims;
      try {
        claims = await verifyToken(authHeader.slice('Bearer '.length));
      } catch (err) {
        if (err instanceof TokenError) {
          return unauthorized(reply, err.reason, err.message);
        }
        throw err;
      }

      const vk = vkMap.lookup(claims);
      if (!vk) {
        // Deny-by-default: authenticated but unmapped users get no key.
        return reply.code(403).send({
          error: 'no_virtual_key',
          error_description:
            'authenticated, but no Bifrost virtual key is mapped for this user — contact the gateway operator',
        });
      }
      request.bridgeVk = vk;
    },
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  let config;
  try {
    config = loadConfigFromEnv();
  } catch (err) {
    console.error(`bridge startup failed: ${err.message}`);
    process.exit(1);
  }
  const app = buildServer(config);
  app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
