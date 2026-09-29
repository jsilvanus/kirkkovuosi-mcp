// OIDC Relying Party: signs the user in at the IdP (e.g. authentik) and continues the pending MCP OAuth
// authorization request at the same consent step a password sign-in reaches. This app never issues ID tokens.
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as client from 'openid-client';
import type { AuthorizationFlow } from '../oauth/authorization-server.js';
import { decodeOAuth, escapeHtml, page, sendHtml } from '../oauth/authorization-server.js';
import type { McpUser, OidcStore, UserStore } from '../storage/interface.js';
import type { OidcConfig } from './config.js';

export const OIDC_COOKIE = 'kirkkovuosi_oidc';
const STATE_TTL_MS = 10 * 60_000;
const RATE_LIMIT = { max: 30, windowMs: 60_000 };

export interface OidcRelyingPartyOptions {
  config: OidcConfig;
  publicUrl: string;
  store: OidcStore;
  users: UserStore;
  flow: AuthorizationFlow;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

function readCookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/** Lazily discovers the IdP. The promise is cached; a failure drops it so a later request retries. */
function createDiscovery(config: OidcConfig): () => Promise<client.Configuration> {
  let pending: Promise<client.Configuration> | undefined;
  return () => {
    pending ??= client.discovery(
      new URL(config.issuer),
      config.clientId,
      undefined,
      config.clientSecret ? client.ClientSecretBasic(config.clientSecret) : client.None(),
      // http: issuers only outside production (config.ts refuses them in production)
      new URL(config.issuer).protocol === 'http:' && !config.production ? { execute: [client.allowInsecureRequests] } : undefined,
    ).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/** Small fixed-window per-IP limiter for the /oidc routes (the app has no other limiter). */
function createRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

export class OidcSignInError extends Error {}

type Claims = Record<string, unknown>;

/**
 * Maps a verified IdP identity to a local user: linked identity → verified (or trusted) email → new user
 * (OIDC_CREATE_USERS) → refused.
 */
export function resolveOidcUser(config: OidcConfig, store: OidcStore, users: UserStore, claims: Claims): McpUser {
  const subject = claims.sub;
  if (typeof subject !== 'string' || !subject) throw new OidcSignInError('The sign-in response had no subject.');

  const linkedId = store.findOidcIdentity(config.issuer, subject);
  if (linkedId) {
    const user = users.getUser(linkedId);
    // A deleted user is refused, as on the password path
    if (!user) throw new OidcSignInError('No account for this sign-in; ask the administrator.');
    store.touchOidcIdentity(config.issuer, subject);
    return user;
  }

  const email = typeof claims.email === 'string' && claims.email.trim() ? claims.email.trim() : undefined;
  const emailTrusted = email !== undefined && (claims.email_verified === true || config.trustEmail);
  if (email && emailTrusted) {
    const existing = users.getUserByEmail(email);
    if (existing) {
      store.linkOidcIdentity(config.issuer, subject, existing.id);
      return existing;
    }
  }

  if (config.createUsers) {
    const name = [claims.name, claims.preferred_username, email].find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim() ?? subject;
    // Don't claim an email that is already another account's, or that the IdP has not verified
    const userEmail = email && emailTrusted && !users.getUserByEmail(email) ? email : undefined;
    const user: McpUser = { id: randomUUID(), name, ...(userEmail ? { email: userEmail } : {}), createdAt: Date.now() };
    users.createUser(user);
    store.linkOidcIdentity(config.issuer, subject, user.id);
    return user;
  }

  throw new OidcSignInError('No account for this sign-in; ask the administrator.');
}

export async function mountOidcRelyingParty(app: FastifyInstance, options: OidcRelyingPartyOptions): Promise<void> {
  const { config, publicUrl, store, users, flow } = options;
  const redirectUri = publicUrl + '/oidc/callback';
  const discover = createDiscovery(config);
  const allow = createRateLimiter(RATE_LIMIT.max, RATE_LIMIT.windowMs);
  const cookieAttributes = '; Path=/oidc; HttpOnly; SameSite=Lax' + (config.production ? '; Secure' : '');
  const setStateCookie = (reply: FastifyReply, state: string) =>
    reply.header('Set-Cookie', OIDC_COOKIE + '=' + encodeURIComponent(state) + cookieAttributes + '; Max-Age=600');
  const clearStateCookie = (reply: FastifyReply) => reply.header('Set-Cookie', OIDC_COOKIE + '=' + cookieAttributes + '; Max-Age=0');

  function retryLink(oauth: string | undefined): string {
    if (oauth) {
      try {
        const query = new URLSearchParams(Object.entries(decodeOAuth(oauth)).filter((e): e is [string, string] => typeof e[1] === 'string'));
        return '<p><a href="/oauth/authorize?' + escapeHtml(query.toString()) + '">Back to sign-in</a></p>';
      } catch { /* fall through */ }
    }
    return '<p>Return to your MCP client and start the sign-in again.</p>';
  }

  function errorPage(reply: FastifyReply, status: number, message: string, oauth?: string) {
    return sendHtml(reply, page('Sign-in failed', '<h1>Sign-in failed</h1><p class="error">' + escapeHtml(message) + '</p>' + retryLink(oauth)), [], status);
  }

  function logFailure(request: FastifyRequest, reason: string, error?: unknown) {
    // Never log tokens, codes or ID tokens: only the error's type, code and message
    const detail = error instanceof Error
      ? { name: error.name, message: error.message, ...('code' in error ? { code: (error as { code: unknown }).code } : {}) }
      : undefined;
    request.log.warn({ oidc: reason, ...(detail ? { err: detail } : {}) }, 'OIDC sign-in failed');
  }

  app.get('/oidc/login', async (request, reply) => {
    if (!allow(request.ip)) return errorPage(reply, 429, 'Too many sign-in attempts. Try again in a minute.');
    const oauth = (request.query as Record<string, string | undefined>).oauth;
    // This app has no web UI of its own: the only purpose is a pending MCP OAuth authorization request
    if (!oauth) return errorPage(reply, 400, 'Invalid authorization request.');
    try {
      await flow.validateEncoded(oauth);
    } catch {
      return sendHtml(reply, page('Invalid request', '<h1>Invalid authorization request</h1>'), [], 400);
    }

    let configuration: client.Configuration;
    try {
      configuration = await discover();
    } catch (error) {
      logFailure(request, 'discovery', error);
      return errorPage(reply, 502, 'The sign-in service is not reachable right now. Try again later.', oauth);
    }

    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    store.saveOidcState({ stateHash: sha256(state), codeVerifier, nonce, purpose: 'oauth', oauth, expires: Date.now() + STATE_TTL_MS });

    const target = client.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      scope: config.scopes,
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    setStateCookie(reply, state);
    return reply.header('Cache-Control', 'no-store').redirect(target.href);
  });

  app.get('/oidc/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!allow(request.ip)) return errorPage(reply, 429, 'Too many sign-in attempts. Try again in a minute.');
    const query = request.query as Record<string, string | undefined>;
    const cookieState = readCookie(request, OIDC_COOKIE);
    clearStateCookie(reply);

    // Login CSRF: the state must come back to the browser that started the sign-in
    if (!query.state || !cookieState || cookieState !== query.state) {
      logFailure(request, 'state_mismatch');
      return errorPage(reply, 400, 'This sign-in link is not valid in this browser. Start the sign-in again.');
    }
    const pending = store.consumeOidcState(sha256(query.state));
    if (!pending) {
      logFailure(request, 'state_unknown_or_used');
      return errorPage(reply, 400, 'This sign-in has expired or was already used. Start the sign-in again.');
    }

    if (query.error) {
      logFailure(request, 'idp_error:' + query.error.slice(0, 100));
      return errorPage(reply, 400, 'The sign-in service refused the sign-in.', pending.oauth);
    }

    let claims: Claims;
    try {
      const configuration = await discover();
      const currentUrl = new URL(redirectUri);
      for (const [key, value] of Object.entries(query)) if (typeof value === 'string') currentUrl.searchParams.set(key, value);
      const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: query.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      claims = { ...(tokens.claims() ?? {}) };
      if (typeof claims.email !== 'string' && typeof claims.sub === 'string') {
        const info = await client.fetchUserInfo(configuration, tokens.access_token, claims.sub);
        for (const key of ['email', 'email_verified', 'name', 'preferred_username']) {
          if (claims[key] === undefined && info[key] !== undefined) claims[key] = info[key];
        }
      }
    } catch (error) {
      logFailure(request, 'code_grant', error);
      return errorPage(reply, 400, 'The sign-in could not be verified. Start the sign-in again.', pending.oauth);
    }

    let user: McpUser;
    try {
      user = resolveOidcUser(config, store, users, claims);
    } catch (error) {
      logFailure(request, 'no_local_user', error);
      const message = error instanceof OidcSignInError ? error.message : 'The sign-in could not be completed.';
      return errorPage(reply, 403, message, pending.oauth);
    }

    if (!pending.oauth) return errorPage(reply, 400, 'Invalid authorization request.');
    try {
      return await flow.showConsent(reply, pending.oauth, user);
    } catch {
      return sendHtml(reply, page('Invalid request', '<h1>Invalid authorization request</h1>'), [], 400);
    }
  });
}
