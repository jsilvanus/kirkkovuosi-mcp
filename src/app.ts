import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { KirkkovuosikalenteriConnector } from './connector.js';
import { mountMcpHttp } from './mcp/http.js';
import { mountOAuthMetadata } from './oauth-metadata.js';
import { mountAuthorizationServer, type AuthorizationServerOptions } from './oauth/authorization-server.js';
import type { AuthStore, OidcStore, UserStore } from './storage/interface.js';
import type { OidcConfig } from './oidc/config.js';
import { mountOidcRelyingParty } from './oidc/relying-party.js';

export interface AppOptions {
  publicUrl: string;
  jwtSecret: Uint8Array;
  store: AuthStore & OidcStore;
  users: UserStore;
  /** OIDC sign-in (SSO) on the authorize page; undefined = off (no button, no /oidc routes). */
  oidc?: OidcConfig | undefined;
  authorization?: AuthorizationServerOptions;
  logger?: boolean;
  /** Defaults to a connector for the live site; tests pass one with a stubbed fetch. */
  connector?: KirkkovuosikalenteriConnector;
}

/** Builds the Fastify app without listening, so tests can run it on an ephemeral port. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(formbody);

  const resource = options.publicUrl + '/mcp';
  await mountOAuthMetadata(app, options.publicUrl);
  const flow = await mountAuthorizationServer(app, options.publicUrl, resource, options.jwtSecret, options.store, options.users, {
    ...options.authorization,
    ...(options.oidc ? { sso: { label: options.oidc.buttonLabel } } : {}),
  });
  if (options.oidc) {
    await mountOidcRelyingParty(app, { config: options.oidc, publicUrl: options.publicUrl, store: options.store, users: options.users, flow });
  }
  await mountMcpHttp(app, {
    connector: options.connector ?? new KirkkovuosikalenteriConnector(),
    publicUrl: options.publicUrl,
    jwtSecret: options.jwtSecret,
    resource,
  });

  app.get('/health', async () => ({ ok: true }));
  return app;
}
