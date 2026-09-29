# CLAUDE.md

## Project

kirkkovuosi-mcp — an MCP server (Streamable HTTP, embedded OAuth) that wraps the public API of Kirkkovuosikalenteri (kirkkovuosikalenteri.fi, Swedish: kyrkoarskalendern.fi), the church year calendar of the Evangelical-Lutheran Church of Finland. It answers live from the site. The sibling repository jsilvanus/anno-api answers from its own data.

Built from the Codestash scaffold `mcp/api-connector-style`. Moved here from anno-api (`packages/kirkkovuosi-mcp`).

## Commands

```bash
npm install
npm run build        # TypeScript → dist/
npm start            # needs .env: MCP_PUBLIC_URL, JWT_SECRET, default user (see .env.example)
npm run dev          # tsx watch
npm run typecheck
npm test             # connector tests on saved responses (no network) + OAuth and OIDC end to end (fake IdP)
```

Node.js ≥ 22.5 (`node:sqlite`).

## Architecture

```
src/connector.ts     KirkkovuosikalenteriConnector — fetch, HTML → text, in-memory cache (6 h)
src/mcp/server.ts    Tools: kvk_day, kvk_lectionary, kvk_liturgical_colors, kvk_search
src/oauth/           Authorization server: sign-in + registration page, consent, PKCE, tokens, CIMD
src/oidc/            Optional OIDC Relying Party (SSO on the sign-in page, openid-client); off unless OIDC_ISSUER is set
src/app.ts           buildApp() for tests; src/server.ts reads the environment and listens
test/fixtures/       Saved API responses (trimmed)
```

The connector knows nothing about OAuth or MCP transport. Read `LEARNED.md` before changing the OAuth plumbing. The OAuth sign-in page is the only web UI.

## The site's API

`.claude/skills/kirkkovuosikalenteri-api/SKILL.md` documents the API (day, colours, search) and every response field. Keep it in step with `src/connector.ts` when either learns something new. Facts worth knowing:

- Dates are `D.M.YYYY`; ISO dates answer 400. Data covers about 2022–2035; outside it the day endpoint answers HTTP 500 `no_calendar_day`.
- On a weekday, `liturgical_days[0]` is the Sunday whose material the week uses.
- Saturday has no vespers of its own: the evening before a Sunday or feast is its first vespers (the next date's `eve`). The site files Saturday's `evening` under the week, which is wrong in years the week is followed by a different Sunday or feast; `kvk_lectionary` returns the right one as `tonight`.
- The colour of a day comes from the colours endpoint (`color` in the day response is almost always null). Colour entries with `rendering: "background"` carry no colour; `_` joins two colours (Holy Saturday).

Be polite to the site: one request per date, cached; a descriptive User-Agent. Texts © Kirkkohallitus; Bible texts Raamattu 1992 © Kirkkohallitus.

## Testing

`node:test` through tsx. All tests must pass before committing. New API behaviour gets a trimmed fixture in `test/fixtures/` (keep only the fields the test needs).
