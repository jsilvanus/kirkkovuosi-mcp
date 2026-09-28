import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SECTIONS, type KirkkovuosikalenteriConnector, type ConnectorContext, type Language, type Section } from '../connector.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const oauthSecuritySchemes = [{ type: 'oauth2' as const, scopes: ['mcp'] }];

function withOAuthSecurity<T extends object>(config: T): T & { securitySchemes: typeof oauthSecuritySchemes } {
  return { ...config, securitySchemes: oauthSecuritySchemes };
}

function contextFromExtra(extra: Extra): ConnectorContext {
  const auth = extra.authInfo;
  const context = auth?.extra;
  return {
    ...(auth?.token ? { accessToken: auth.token } : {}),
    ...(typeof context?.userId === 'string' ? { userId: context.userId } : {}),
  };
}

function result(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function authError(publicUrl: string): CallToolResult {
  return {
    content: [{ type: 'text', text: 'Authentication required.' }],
    isError: true,
    _meta: {
      // ChatGPT needs both error and error_description here to show its sign-in UI.
      'mcp/www_authenticate': [
        'Bearer resource_metadata="' + publicUrl + '/.well-known/oauth-protected-resource/mcp", scope="mcp", ' +
          'error="insufficient_scope", error_description="Sign in to use this tool."',
      ],
    },
  };
}

function errorResult(error: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export interface McpServerOptions {
  connector: KirkkovuosikalenteriConnector;
  publicUrl: string;
}

const INSTRUCTIONS = [
  'Kirkkovuosikalenteri (kirkkovuosikalenteri.fi / kyrkoarskalendern.fi), the church year calendar of the',
  'Evangelical-Lutheran Church of Finland, answered live from its public API. For a date: the holy day (on a weekday,',
  'the preceding Sunday), period, colour and altar candles, the Bible texts of all three year cycles with the active one,',
  'psalm and hallelujah verse, prayers, hymn recommendations, and the weekly lectionary (morning, midday and evening',
  'prayer, day psalm, eve reading, week psalm, apocrypha). Finnish (fi) or Swedish (sv). Dates are in Finnish time.',
  'The calendar covers roughly the church years 2022–2035.',
].join(' ');

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Date as YYYY-MM-DD. Defaults to today in Finland.');
const languageArg = z.enum(['fi', 'sv']).optional().describe('fi (default) or sv.');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: 'kirkkovuosikalenteri', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const { connector, publicUrl } = options;

  const tool = <A>(handler: (args: A, context: ConnectorContext) => Promise<unknown>) =>
    async (args: A, extra: Extra): Promise<CallToolResult> => {
      if (!extra.authInfo?.token) return authError(publicUrl);
      try {
        return result(await handler(args, contextFromExtra(extra)));
      } catch (error) {
        return errorResult(error);
      }
    };

  server.registerTool(
    'kvk_day',
    withOAuthSecurity({
      title: 'Church year calendar day',
      description: 'Everything Kirkkovuosikalenteri has for a date: the holy day(s) or on a weekday the preceding Sunday, period, ' +
        'colour, altar candles, description; Bible texts of all three year cycles (activeYearCycle is this church year), psalm and ' +
        'hallelujah verse; the weekly lectionary (eve, morning, noon, evening, dayPsalm, weekPsalm, apocrypha); prayers; hymns. ' +
        'Use `sections` to limit the answer.',
      inputSchema: {
        date: dateArg,
        language: languageArg,
        sections: z.array(z.enum(['texts', 'lectionary', 'prayers', 'hymns'])).optional()
          .describe('Which parts to include (default all). The basic day info is always included.'),
      },
      annotations: readOnly,
    }),
    tool<{ date?: string | undefined; language?: Language | undefined; sections?: Section[] | undefined }>((args, ctx) =>
      connector.day(args.date, args.language ?? 'fi', args.sections ?? SECTIONS, ctx)),
  );

  server.registerTool(
    'kvk_lectionary',
    withOAuthSecurity({
      title: 'Daily prayer texts',
      description: 'The weekly lectionary (viikkolektionaari) for a date: morning and evening reading, the psalms of the morning, ' +
        'midday and evening prayer, the day psalm, and on Sundays and holy days their first vespers, week psalm and apocrypha text. ' +
        'Saturday has no vespers of its own: `tonight` is the evening prayer to use — the next Sunday\'s or feast\'s first vespers ' +
        'on the evening before it, a Sunday\'s or feast\'s own second vespers on the day. ' +
        'Psalms include cadence marks for chanting (`chant`).',
      inputSchema: { date: dateArg, language: languageArg },
      annotations: readOnly,
    }),
    tool<{ date?: string | undefined; language?: Language | undefined }>((args, ctx) =>
      connector.lectionary(args.date, args.language ?? 'fi', ctx)),
  );

  server.registerTool(
    'kvk_liturgical_colors',
    withOAuthSecurity({
      title: 'Liturgical colours of a month',
      description: 'The liturgical colour of every day of a month (valkoinen, violetti, sininen, vihreä, punainen, musta).',
      inputSchema: {
        year: z.number().int().min(2000).max(2100),
        month: z.number().int().min(1).max(12),
      },
      annotations: readOnly,
    }),
    tool<{ year: number; month: number }>((args, ctx) => connector.liturgicalColors(args.year, args.month, ctx)),
  );

  server.registerTool(
    'kvk_search',
    withOAuthSecurity({
      title: 'Search the calendar',
      description: 'Search Kirkkovuosikalenteri for holy days and pages by name, e.g. "mikkelinpäivä" or "adventti".',
      inputSchema: { query: z.string().min(1), language: languageArg },
      annotations: readOnly,
    }),
    tool<{ query: string; language?: Language | undefined }>((args, ctx) => connector.search(args.query, args.language ?? 'fi', ctx)),
  );

  return server;
}
