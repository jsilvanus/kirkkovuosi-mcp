# Kirkkovuosikalenteri MCP

MCP server that wraps the public API of [Kirkkovuosikalenteri](https://www.kirkkovuosikalenteri.fi/) (and its Swedish side [Kyrkoårskalendern](https://www.kyrkoarskalendern.fi/)), the church year calendar of the Evangelical-Lutheran Church of Finland. It answers live from the site. Its sibling [anno-api](https://github.com/jsilvanus/anno-api) has a REST API and an MCP server that answer from their own data (Evankeliumikirja, Jumalanpalvelusten kirja, propers and rubrics).

Built from the Codestash scaffold `mcp/api-connector-style` (jsilvanus/codestash, branch `claude/fix-consent-login-ticket`, which has the consent-step fix). The API calls are in `src/connector.ts`, the tools in `src/mcp/server.ts`; OAuth, CIMD, storage and transport are the scaffold's.

## Tools

All read-only.

| Tool | Arguments | Returns |
|---|---|---|
| `kvk_day` | `date?`, `language?` (`fi`/`sv`), `sections?` (`texts`, `lectionary`, `prayers`, `hymns`) | Everything for a date: holy day(s) or on a weekday the preceding Sunday, period, colour, altar candles, description; Bible texts of all three year cycles with the active one; psalm and hallelujah verse; weekly lectionary; prayers; hymns |
| `kvk_lectionary` | `date?`, `language?` | The weekly lectionary: first vespers, morning, noon and evening prayer, day psalm, week psalm, apocrypha — psalms with cadence marks (`chant`). `tonight` is the evening prayer to use: the next Sunday's or feast's first vespers on the evening before it (Saturday has no vespers of its own; the site files Saturday evening under the week, which is wrong in some years), the day's own second vespers on a Sunday or feast |
| `kvk_liturgical_colors` | `year`, `month` | The colour(s) of every day of a month (two on Holy Saturday); `marked` where the site's calendar view highlights a day (undocumented) |
| `kvk_search` | `query`, `language?` | Holy days and pages by name |

The site's HTML is converted to plain text with line breaks; psalms keep the two-space indentation of the second half-verse, and their `chant` version keeps the cadence marks (`*` pause, `_x_` the syllable where the cadence starts). Responses are cached in memory for 6 hours.

## API used

| Endpoint | Returns |
|---|---|
| `/wp-json/kirkkovuosi/v1/day/{fi\|sv}/{D.M.YYYY}` | Everything for a date (data for about church years 2022–2035) |
| `/wp-json/liturgicalColors/v1/{year}/{month}` | Colour class of each day of a month |
| `/wp-json/wp/v2/search?search=…` | Site search |

Texts © Kirkkohallitus; Bible texts Raamattu (1992) © Kirkkohallitus.

## Start

    cp .env.example .env    # set MCP_PUBLIC_URL, JWT_SECRET and the default user
    npm install
    npm run build
    npm start

    npm test                # connector tests use saved responses (no network) + OAuth end to end

Node.js 22.5 or newer (`node:sqlite`).

## Using the API without this server

[`.claude/skills/kirkkovuosikalenteri-api/SKILL.md`](.claude/skills/kirkkovuosikalenteri-api/SKILL.md) instructs an AI to use the site's public API directly: endpoints, date format, coverage, errors and every field of the response. It works as a Claude Code skill or pasted into any system prompt.

## Modern baseline

- MCP Streamable HTTP
- stateless request handling
- OAuth authorization code + PKCE S256
- issuer- and MCP-resource-bound JWT access tokens
- refresh tokens
- **CIMD-first client identification**
- OAuth Protected Resource Metadata (at `/.well-known/oauth-protected-resource/mcp` and the root)
- `/mcp` answers requests without a valid token with 401 + `WWW-Authenticate` (`requireAuth`, default on)
- OAuth Authorization Server Metadata
- embedded authorization server
- Content-Security-Policy on the OAuth pages whose `form-action` allows the client's redirect (see `LEARNED.md`)

CIMD is the normal client-registration mechanism. Dynamic Client Registration is intentionally not part of the default scaffold.

## Start

    cp .env.example .env
    npm install
    npm run build
    npm start

Run the end-to-end OAuth test (sign-in → consent → PKCE token exchange → `/mcp`):

    npm test

Implement `src/connector.ts`. The embedded authorization server has a default SQLite-backed user store, password login, a small consent screen, authorization-code + PKCE handling, and durable token/code storage. Set the default user's credentials in .env, or manage users with the CRUD script below. Replace the demo account/bootstrap policy with your application's identity and authorization policy before production.

## Architecture

    MCP client
        |
        | Streamable HTTP + Bearer token
        v
    MCP resource server
        |
        +---- OAuth discovery
        |
        +---- embedded OAuth authorization server
        |       CIMD -> authorize -> PKCE -> token
        |
        v
    connector.ts
        |
        v
    External API

The connector should not know about OAuth or MCP transport details.

`src/app.ts` exports `buildApp()`, which assembles the Fastify app (discovery, authorization server, `/mcp`) without listening; `src/server.ts` reads the environment, bootstraps the default user and listens. Tests use `buildApp()` with a temporary SQLite database and a stubbed CIMD fetch (`authorization.fetchClientMetadata`).

See `LEARNED.md` for the design decisions and client quirks learned from ptv-mcp, farcmd-mcp and anno-api. Read it before changing the OAuth plumbing.

### Persistence

The scaffold uses a local SQLite file by default. OAuth authorization codes and refresh tokens survive process restarts without requiring a database server.

Set `STORAGE_PATH` to change the database location:

```env
STORAGE_PATH=./data/app.sqlite
```

The storage API is deliberately small and lives under `src/storage/`. A future Postgres implementation can replace `SqliteAuthStore` without changing the MCP or connector layers. The SQLite file is gitignored.


### MCP user CRUD

The scaffold includes a small development/admin CLI using the same SQLite database:

    npm run user -- create --name "Demo User" --email "demo@example.com" --password "change-me"
    npm run user -- list
    npm run user -- get <id>
    npm run user -- update <id> --name "New Name" --email "new@example.com" --password "new-secret"
    npm run user -- delete <id>

Passwords are stored as Argon2id hashes and are never printed by the CLI.

On first server start, the configured MCP_DEFAULT_USER_ID is created automatically when missing, using MCP_DEFAULT_USER_EMAIL and MCP_DEFAULT_USER_PASSWORD. The default OAuth flow is:

    MCP client
        |
        | authorization request
        v
    /oauth/authorize
        |
        +--> sign-in (email + password)
        |
        +--> consent (approve / deny, authenticated by a signed login ticket)
        |
        +--> authorization code
        |
        v
    /oauth/token


## Development continuation

This scaffold is intended to be copied into a new MCP connector project. The normal development loop is:

1. Copy this directory into a new connector location.
2. Implement the external API calls in `src/connector.ts`.
3. Adjust the connector-specific MCP tools in `src/mcp/server.ts`.
4. Configure `.env`, especially `MCP_PUBLIC_URL`, `JWT_SECRET`, and the default user credentials.
5. Run `npm install`, then `npm run build`, `npm test` and `npm run dev`.
6. Exercise the OAuth flow with a real MCP client and verify that the authenticated user's ID and bearer token reach the connector through `ConnectorContext`.

Keep the generic OAuth, CIMD, persistence, and HTTP/MCP plumbing unchanged unless the connector has a concrete reason to diverge. Connector-specific behavior should stay in `connector.ts` and the MCP tool definitions.

## Production hardening still required

The included user management and login flow is deliberately a small scaffold, not a complete identity-management system. Before exposing it to production users, add the user/account controls appropriate to the deployment, including:

- password reset and account recovery
- email verification, if email is used as an account identifier
- password-change flow for authenticated users
- account disable/enable and other administrative lifecycle controls
- login/session abuse protection, such as rate limiting and brute-force protection
- secure session handling if browser login sessions are introduced
- CSRF protection for browser-based state-changing endpoints
- audit logging for authentication, authorization, and user administration
- appropriate password policy and credential handling
- secret rotation and secure secret storage
- refresh-token revocation/rotation and logout semantics
- protection against stale/deleted users retaining access through existing tokens
- a real production identity/bootstrap process instead of relying on the demo account environment variables

The current CRUD CLI is a development/admin primitive. It intentionally does not attempt to become a general-purpose identity-management interface.

The default OAuth login and consent pages are also intentionally minimal. Replace their presentation and, where necessary, their surrounding account/session flow with the host application's production UX and security controls.

## Suggested first production step

Do not expand the scaffold into a large authentication framework prematurely. First use the scaffold with one real connector and validate the complete flow:

`CIMD client → OAuth login → consent → PKCE token exchange → /mcp → connector`.

Then add only the identity and account-management features that the target deployment actually requires.
