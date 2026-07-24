/**
 * RFC 9728 Protected Resource Metadata.
 *
 * Served at /.well-known/oauth-protected-resource (and the path-suffixed
 * variant for the /mcp resource). This document is what lets Claude Desktop
 * discover the authorization server instead of failing with
 * mcp_registration_failed.
 */
export function buildProtectedResourceMetadata({ publicOrigin, authorizationServer, scopes }) {
  return {
    resource: publicOrigin,
    authorization_servers: [authorizationServer],
    bearer_methods_supported: ['header'],
    scopes_supported: scopes,
  };
}

export function wwwAuthenticateValue(publicOrigin, error) {
  const parts = ['Bearer'];
  const params = [];
  if (error) params.push(`error="${error}"`);
  params.push(`resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource"`);
  parts.push(params.join(', '));
  return parts.join(' ');
}
