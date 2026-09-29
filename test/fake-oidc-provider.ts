/**
 * A small fake OIDC provider for tests: discovery, JWKS, authorize (302 back with code + state),
 * token (checks PKCE, signs an RS256 ID token) and userinfo. `identity` decides who signs in next.
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface FakeIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** Leave email out of the ID token so the RP must call userinfo. */
  emailOnlyInUserinfo?: boolean;
}

export interface FakeOidcProvider {
  issuer: string;
  clientId: string;
  identity: FakeIdentity;
  /** Next /authorize answers with this error instead of a code. */
  nextError?: string;
  close(): Promise<void>;
}

export async function startFakeOidcProvider(clientId = 'kirkkovuosi-test'): Promise<FakeOidcProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { identity: FakeIdentity; nonce: string; challenge: string; redirectUri: string }>();
  const accessTokens = new Map<string, FakeIdentity>();

  const provider: FakeOidcProvider = {
    issuer: '',
    clientId,
    identity: { sub: 'user-1', email: 'test@example.com', email_verified: true, name: 'Test User' },
    close: () => new Promise(resolve => server.close(() => resolve())),
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', provider.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: provider.issuer,
        authorization_endpoint: provider.issuer + '/authorize',
        token_endpoint: provider.issuer + '/token',
        userinfo_endpoint: provider.issuer + '/userinfo',
        jwks_uri: provider.issuer + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });

    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== clientId || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('scope')?.split(' ').includes('openid')) {
        return json(400, { error: 'invalid_request' });
      }
      const target = new URL(p.get('redirect_uri')!);
      if (provider.nextError) {
        target.searchParams.set('error', provider.nextError);
        provider.nextError = undefined;
      } else {
        const code = randomBytes(16).toString('base64url');
        codes.set(code, { identity: { ...provider.identity }, nonce: p.get('nonce') ?? '', challenge: p.get('code_challenge')!, redirectUri: p.get('redirect_uri')! });
        target.searchParams.set('code', code);
      }
      target.searchParams.set('state', p.get('state') ?? '');
      res.writeHead(302, { location: target.href });
      return res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = new URLSearchParams(raw);
      const entry = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      const verifier = body.get('code_verifier') ?? '';
      if (!entry || body.get('redirect_uri') !== entry.redirectUri || createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) {
        return json(400, { error: 'invalid_grant' });
      }
      const { emailOnlyInUserinfo, sub, ...profile } = entry.identity;
      const idToken = await new SignJWT({ nonce: entry.nonce, ...(emailOnlyInUserinfo ? { name: profile.name } : profile) })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(provider.issuer)
        .setAudience(clientId)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const accessToken = randomBytes(16).toString('base64url');
      accessTokens.set(accessToken, entry.identity);
      return json(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }

    if (url.pathname === '/userinfo') {
      const identity = accessTokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!identity) return json(401, { error: 'invalid_token' });
      const { emailOnlyInUserinfo: _, ...claims } = identity;
      return json(200, claims);
    }

    json(404, { error: 'not_found' });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  provider.issuer = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return provider;
}
