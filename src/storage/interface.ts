export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  subject: string;
  scope: string;
  expires: number;
}

export interface RefreshTokenRecord {
  token: string;
  clientId: string;
  subject: string;
  scope: string;
  expires: number;
}

export interface AuthStore {
  saveAuthorizationCode(record: AuthorizationCodeRecord): void;
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | undefined;
  saveRefreshToken(record: RefreshTokenRecord): void;
  getRefreshToken(token: string): RefreshTokenRecord | undefined;
}

export interface McpUser {
  id: string;
  name: string;
  email?: string;
  passwordHash?: string;
  createdAt: number;
}

export interface UserStore {
  createUser(user: McpUser): void;
  listUsers(): McpUser[];
  getUser(id: string): McpUser | undefined;
  getUserByEmail(email: string): McpUser | undefined;
  updateUser(id: string, patch: { name?: string; email?: string; passwordHash?: string }): McpUser | undefined;
  deleteUser(id: string): boolean;
}

/** A pending OIDC sign-in, keyed by SHA-256 of its state. Single use, 10 minutes. */
export interface OidcStateRecord {
  stateHash: string;
  codeVerifier: string;
  nonce: string;
  purpose: 'oauth' | 'web';
  /** The encoded pending OAuth authorization request (purpose `oauth`). */
  oauth?: string;
  expires: number;
}

export interface OidcStore {
  saveOidcState(record: OidcStateRecord): void;
  /** Returns and deletes the record (single use); expired records are not returned. Also purges expired rows. */
  consumeOidcState(stateHash: string): OidcStateRecord | undefined;
  /** Local user id linked to the IdP identity (issuer, subject), if any. */
  findOidcIdentity(issuer: string, subject: string): string | undefined;
  linkOidcIdentity(issuer: string, subject: string, userId: string): void;
  touchOidcIdentity(issuer: string, subject: string): void;
}
