/**
 * OIDC sign-in (the app as Relying Party) against a fake OIDC provider:
 * authorize page → SSO button → IdP → /oidc/callback → consent → token → /mcp.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { hash } from '@node-rs/argon2';
import { buildApp } from '../src/app.js';
import { SqliteAuthStore, SqliteUserStore } from '../src/storage/sqlite.js';
import { parseOidcConfig, type OidcConfig } from '../src/oidc/config.js';
import { startFakeOidcProvider, type FakeOidcProvider } from './fake-oidc-provider.js';

const PUBLIC_URL = 'http://127.0.0.1';
const CLIENT_ID = 'https://client.example/oauth/client.json';
const REDIRECT_URI = 'https://client.example/callback';
const EMAIL = 'test@example.com';
const PASSWORD = 'correct-horse-battery';

let idp: FakeOidcProvider;
const cleanup: Array<() => Promise<void> | void> = [];

before(async () => { idp = await startFakeOidcProvider(); });
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
  await idp.close();
});

interface TestApp { app: FastifyInstance; base: string; users: SqliteUserStore; store: SqliteAuthStore }

async function startApp(oidcEnv: Record<string, string> | null): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'kvk-oidc-'));
  const store = new SqliteAuthStore(join(dir, 'test.sqlite'));
  const users = new SqliteUserStore(store.getDatabase());
  users.createUser({ id: 'test-user', name: 'Test User', email: EMAIL, passwordHash: await hash(PASSWORD, { algorithm: 2 }), createdAt: Date.now() });
  const oidc: OidcConfig | undefined = oidcEnv
    ? parseOidcConfig({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, ...oidcEnv })
    : undefined;
  const app = await buildApp({
    publicUrl: PUBLIC_URL,
    jwtSecret: randomBytes(32),
    store,
    users,
    oidc,
    logger: false,
    authorization: {
      fetchClientMetadata: async (clientId: string) => ({ client_id: clientId, client_name: 'Test Client', redirect_uris: [REDIRECT_URI] }),
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, base, users, store };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeQuery(challenge: string) {
  return new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', scope: 'mcp', resource: PUBLIC_URL + '/mcp',
  });
}

const hidden = (html: string, name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
const ssoHref = (html: string) => html.match(/href="(\/oidc\/login\?oauth=[^"]*)"/)?.[1]?.replaceAll('&amp;', '&');

async function postForm(base: string, path: string, form: Record<string, string>) {
  return fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(), redirect: 'manual',
  });
}

/** Authorize page → SSO button → IdP. Returns what the browser holds before it lands on /oidc/callback. */
async function startSso(t: TestApp, challenge = pkce().challenge) {
  const pageRes = await fetch(t.base + '/oauth/authorize?' + authorizeQuery(challenge));
  const html = await pageRes.text();
  const href = ssoHref(html);
  assert.ok(href, 'SSO button on the sign-in page');
  const login = await fetch(t.base + href, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const setCookie = login.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0]!;
  const idpRedirect = new URL(login.headers.get('location')!);
  assert.equal(idpRedirect.origin, idp.issuer);
  const back = await fetch(idpRedirect, { redirect: 'manual' });
  assert.equal(back.status, 302);
  const callback = new URL(back.headers.get('location')!);
  assert.equal(callback.origin + callback.pathname, PUBLIC_URL + '/oidc/callback');
  const callbackUrl = t.base + callback.pathname + callback.search;
  return { oauth: hidden(html, 'oauth')!, cookie, setCookie, callbackUrl };
}

async function finishSso(callbackUrl: string, cookie: string | undefined) {
  const res = await fetch(callbackUrl, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return { res, html: await res.text() };
}

async function mcp(base: string, token: string, body: unknown) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  return { status: res.status, message: data[0] ?? (text ? JSON.parse(text) : null) };
}

describe('OIDC configuration', () => {
  it('is off without OIDC_ISSUER', () => {
    assert.equal(parseOidcConfig({}), undefined);
    assert.equal(parseOidcConfig({ OIDC_ISSUER: '  ', OIDC_CLIENT_ID: 'x' }), undefined);
  });

  it('applies defaults', () => {
    const config = parseOidcConfig({ OIDC_ISSUER: 'https://auth.example.org/application/o/kvk/', OIDC_CLIENT_ID: 'kvk' })!;
    assert.equal(config.issuer, 'https://auth.example.org/application/o/kvk/');
    assert.equal(config.scopes, 'openid email profile');
    assert.equal(config.buttonLabel, 'Sign in with single sign-on');
    assert.equal(config.createUsers, false);
    assert.equal(config.trustEmail, false);
    assert.equal(config.clientSecret, undefined);
  });

  it('rejects invalid settings', () => {
    const ok = { OIDC_ISSUER: 'https://auth.example.org/', OIDC_CLIENT_ID: 'kvk' };
    assert.throws(() => parseOidcConfig({ OIDC_ISSUER: 'https://auth.example.org/' }), /OIDC_CLIENT_ID/);
    assert.throws(() => parseOidcConfig({ ...ok, OIDC_ISSUER: 'auth.example.org' }), /absolute URL/);
    assert.throws(() => parseOidcConfig({ ...ok, OIDC_ISSUER: 'http://auth.example.org/', NODE_ENV: 'production' }), /https/);
    assert.ok(parseOidcConfig({ ...ok, OIDC_ISSUER: 'http://auth.example.org/' }));
    assert.throws(() => parseOidcConfig({ ...ok, OIDC_SCOPES: 'email profile' }), /openid/);
    assert.throws(() => parseOidcConfig({ ...ok, OIDC_CREATE_USERS: 'maybe' }), /OIDC_CREATE_USERS/);
    assert.throws(() => parseOidcConfig({ ...ok, OIDC_TRUST_EMAIL: 'yes please' }), /OIDC_TRUST_EMAIL/);
  });
});

describe('OIDC off', () => {
  it('shows no SSO button and has no /oidc routes', async () => {
    const t = await startApp(null);
    const html = await (await fetch(t.base + '/oauth/authorize?' + authorizeQuery(pkce().challenge))).text();
    assert.doesNotMatch(html, /oidc/);
    assert.equal((await fetch(t.base + '/oidc/login?oauth=x', { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(t.base + '/oidc/callback?state=x&code=y', { redirect: 'manual' })).status, 404);
    const metadata = await (await fetch(t.base + '/.well-known/openid-configuration')).json() as Record<string, unknown>;
    assert.equal(metadata.jwks_uri, undefined);
  });
});

describe('OIDC sign-in', () => {
  let t: TestApp;
  before(async () => { t = await startApp({ OIDC_BUTTON_LABEL: 'Kirjaudu SSO:lla' }); });

  it('shows the SSO button next to the password form', async () => {
    const html = await (await fetch(t.base + '/oauth/authorize?' + authorizeQuery(pkce().challenge))).text();
    assert.match(html, /Kirjaudu SSO:lla/);
    assert.match(html, /name="password"/);
  });

  it('completes the MCP OAuth flow and the token works on /mcp', async () => {
    idp.identity = { sub: 'flow-1', email: 'TEST@example.com', email_verified: true, name: 'IdP Name' };
    const { verifier, challenge } = pkce();
    const sso = await startSso(t, challenge);
    assert.match(sso.setCookie, /^kirkkovuosi_oidc=/);
    assert.match(sso.setCookie, /HttpOnly/);
    assert.match(sso.setCookie, /SameSite=Lax/);
    assert.match(sso.setCookie, /Path=\/oidc/);
    assert.match(sso.setCookie, /Max-Age=600/);
    assert.doesNotMatch(sso.setCookie, /Secure/); // not production

    const { res, html } = await finishSso(sso.callbackUrl, sso.cookie);
    assert.equal(res.status, 200);
    assert.match(html, /Test Client/);
    assert.match(html, /Test User/); // linked to the existing local account by verified email
    assert.match(res.headers.get('content-security-policy') ?? '', /https:\/\/client\.example/);
    assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.equal(hidden(html, 'oauth'), sso.oauth);

    const approved = await postForm(t.base, '/oauth/authorize', { oauth: sso.oauth, ticket: hidden(html, 'ticket')!, action: 'approve' });
    assert.equal(approved.status, 302);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await postForm(t.base, '/oauth/token', {
      grant_type: 'authorization_code', code, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_verifier: verifier,
    });
    assert.equal(tokenRes.status, 200);
    const tokens = await tokenRes.json() as { access_token: string };
    const list = await mcp(t.base, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(list.status, 200);
    assert.ok(list.message.result.tools.some((tool: { name: string }) => tool.name === 'kvk_day'));
    assert.equal(t.store.findOidcIdentity(idp.issuer, 'flow-1'), 'test-user');

    // Next time the linked identity decides, whatever the email says now
    idp.identity = { sub: 'flow-1', email: 'someone-else@example.com', email_verified: true };
    const again = await startSso(t);
    const second = await finishSso(again.callbackUrl, again.cookie);
    assert.equal(second.res.status, 200);
    assert.match(second.html, /Test User/);
  });

  it('reads the email from userinfo when the ID token has none', async () => {
    idp.identity = { sub: 'userinfo-1', email: EMAIL, email_verified: true, emailOnlyInUserinfo: true };
    const sso = await startSso(t);
    const { res, html } = await finishSso(sso.callbackUrl, sso.cookie);
    assert.equal(res.status, 200);
    assert.match(html, /Test User/);
  });

  it('refuses a callback whose state does not match the cookie', async () => {
    idp.identity = { sub: 'csrf-1', email: EMAIL, email_verified: true };
    const sso = await startSso(t);
    assert.equal((await finishSso(sso.callbackUrl, undefined)).res.status, 400);
    const other = await startSso(t);
    const mismatched = await finishSso(sso.callbackUrl, other.cookie);
    assert.equal(mismatched.res.status, 400);
    assert.doesNotMatch(mismatched.html, /name="ticket"/);
  });

  it('refuses a replayed state', async () => {
    idp.identity = { sub: 'replay-1', email: EMAIL, email_verified: true };
    const sso = await startSso(t);
    assert.equal((await finishSso(sso.callbackUrl, sso.cookie)).res.status, 200);
    const replay = await finishSso(sso.callbackUrl, sso.cookie);
    assert.equal(replay.res.status, 400);
    assert.match(replay.html, /expired or was already used/);
  });

  it('shows an error page when the IdP answers with an error', async () => {
    idp.nextError = 'access_denied';
    const sso = await startSso(t);
    const { res, html } = await finishSso(sso.callbackUrl, sso.cookie);
    assert.equal(res.status, 400);
    assert.match(html, /Sign-in failed/);
    assert.match(html, /href="\/oauth\/authorize\?/);
  });

  it('rejects an invalid or missing authorization request at /oidc/login', async () => {
    assert.equal((await fetch(t.base + '/oidc/login', { redirect: 'manual' })).status, 400);
    const bad = Buffer.from('response_type=code&client_id=' + encodeURIComponent(CLIENT_ID) + '&redirect_uri=https%3A%2F%2Fevil.example%2F').toString('base64url');
    assert.equal((await fetch(t.base + '/oidc/login?oauth=' + bad, { redirect: 'manual' })).status, 400);
  });

  it('does not link by an unverified email without OIDC_TRUST_EMAIL', async () => {
    idp.identity = { sub: 'unverified-1', email: EMAIL, email_verified: false };
    const sso = await startSso(t);
    const { res, html } = await finishSso(sso.callbackUrl, sso.cookie);
    assert.equal(res.status, 403);
    assert.match(html, /No account for this sign-in/);
    assert.equal(t.store.findOidcIdentity(idp.issuer, 'unverified-1'), undefined);
  });

  it('refuses an unknown user when OIDC_CREATE_USERS is off', async () => {
    idp.identity = { sub: 'unknown-1', email: 'nobody@example.com', email_verified: true };
    const sso = await startSso(t);
    assert.equal((await finishSso(sso.callbackUrl, sso.cookie)).res.status, 403);
  });

  it('refuses a user deleted after linking', async () => {
    t.users.createUser({ id: 'gone', name: 'Gone', email: 'gone@example.com', createdAt: Date.now() });
    idp.identity = { sub: 'gone-1', email: 'gone@example.com', email_verified: true };
    const first = await startSso(t);
    assert.equal((await finishSso(first.callbackUrl, first.cookie)).res.status, 200);
    t.users.deleteUser('gone');
    const second = await startSso(t);
    assert.equal((await finishSso(second.callbackUrl, second.cookie)).res.status, 403);
  });

  it('keeps password sign-in working', async () => {
    const pageRes = await fetch(t.base + '/oauth/authorize?' + authorizeQuery(pkce().challenge));
    const oauth = hidden(await pageRes.text(), 'oauth')!;
    const res = await postForm(t.base, '/oauth/authorize', { oauth, email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 200);
    assert.ok(hidden(await res.text(), 'ticket'));
  });
});

describe('OIDC with OIDC_TRUST_EMAIL and OIDC_CREATE_USERS', () => {
  it('links an unverified email when trusted', async () => {
    const t = await startApp({ OIDC_TRUST_EMAIL: 'true' });
    idp.identity = { sub: 'trusted-1', email: EMAIL, email_verified: false };
    const sso = await startSso(t);
    const { res, html } = await finishSso(sso.callbackUrl, sso.cookie);
    assert.equal(res.status, 200);
    assert.match(html, /Test User/);
    assert.equal(t.store.findOidcIdentity(idp.issuer, 'trusted-1'), 'test-user');
  });

  it('creates a local user without a password', async () => {
    const t = await startApp({ OIDC_CREATE_USERS: 'true' });
    idp.identity = { sub: 'new-1', email: 'new@example.com', email_verified: true, name: 'New Person' };
    const sso = await startSso(t);
    const { res, html } = await finishSso(sso.callbackUrl, sso.cookie);
    assert.equal(res.status, 200);
    assert.match(html, /New Person/);
    const userId = t.store.findOidcIdentity(idp.issuer, 'new-1')!;
    const user = t.users.getUser(userId)!;
    assert.equal(user.email, 'new@example.com');
    assert.equal(user.passwordHash, undefined);

    // An unverified email is not stored on the new account
    idp.identity = { sub: 'new-2', email: 'unverified@example.com', email_verified: false, name: 'Unverified' };
    const other = await startSso(t);
    assert.equal((await finishSso(other.callbackUrl, other.cookie)).res.status, 200);
    assert.equal(t.users.getUser(t.store.findOidcIdentity(idp.issuer, 'new-2')!)!.email, undefined);
  });
});
