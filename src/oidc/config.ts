// OIDC Relying Party configuration from the environment. OIDC_ISSUER unset or empty = OIDC is off.

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string;
  buttonLabel: string;
  createUsers: boolean;
  trustEmail: boolean;
  /** Secure cookie flag and https-only issuer. */
  production: boolean;
}

export const DEFAULT_OIDC_SCOPES = 'openid email profile';
export const DEFAULT_OIDC_BUTTON_LABEL = 'Sign in with single sign-on';

function parseBoolean(name: string, value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '') return false;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new Error(`${name} must be true or false, got: ${value}`);
}

/** Returns undefined when OIDC is off; throws a descriptive error on invalid configuration. */
export function parseOidcConfig(env: NodeJS.ProcessEnv): OidcConfig | undefined {
  const issuer = env.OIDC_ISSUER?.trim();
  if (!issuer) return undefined;

  const production = env.NODE_ENV === 'production';
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error('OIDC_ISSUER must be an absolute URL, got: ' + issuer);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('OIDC_ISSUER must be an http(s) URL');
  if (production && url.protocol !== 'https:') throw new Error('OIDC_ISSUER must use https in production');

  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!clientId) throw new Error('OIDC_CLIENT_ID is required when OIDC_ISSUER is set');

  const scopes = env.OIDC_SCOPES?.trim() || DEFAULT_OIDC_SCOPES;
  if (!scopes.split(/\s+/).includes('openid')) throw new Error('OIDC_SCOPES must contain openid');

  const clientSecret = env.OIDC_CLIENT_SECRET || undefined;
  return {
    issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    scopes,
    buttonLabel: env.OIDC_BUTTON_LABEL?.trim() || DEFAULT_OIDC_BUTTON_LABEL,
    createUsers: parseBoolean('OIDC_CREATE_USERS', env.OIDC_CREATE_USERS),
    trustEmail: parseBoolean('OIDC_TRUST_EMAIL', env.OIDC_TRUST_EMAIL),
    production,
  };
}
