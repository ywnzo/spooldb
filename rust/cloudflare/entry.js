import RustRelay, {SpoolWorkspace, SpoolProject} from './build/index.js';
import {authenticatedRelay} from '../../src/cloudflare/oauth.js';

export {SpoolWorkspace, SpoolProject};

// Keep the provider's existing OAuth KV format. The authenticated connection
// comes from verified provider context, never from public request headers.
async function mcpHandler(request, env, context) {
  const url = new URL(request.url);
  url.pathname = '/_spool/oauth-mcp';
  url.search = '';
  const headers = new Headers(request.headers);
  headers.set('x-spool-oauth-context', JSON.stringify({
    connection: context.props?.connection,
    scopes: context.auth.scope,
    userId: context.auth.userId,
  }));
  return env.WORKSPACE.get(env.WORKSPACE.idFromName('workspace')).fetch(
    new Request(url, {method: request.method, headers, body: request.body}),
  );
}

export default authenticatedRelay({fetch(request, env, context) { return new RustRelay(context, env).fetch(request); }}, {mcpHandler});
