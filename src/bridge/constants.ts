/**
 * Slash commands handled by {@link CommandHandler}.
 * Values are the literal `/…` strings (always lowercase for `cmd.toLowerCase()` matching).
 */
export const SLASH_CMD = {
  help: '/help',
  reset: '/reset',
  stop: '/stop',
  status: '/status',
  cd: '/cd',
  memory: '/memory',
  sync: '/sync',
  model: '/model',
  usage: '/usage',
} as const;

export type SlashCommand = (typeof SLASH_CMD)[keyof typeof SLASH_CMD];

/** Titles and Feishu card colors for `/usage` text notices. */
export const USAGE_TEXT = {
  TITLE_ERROR: '❌ /usage',
  TITLE_REPORT: '📈 Claude Code 用量',
  COLOR_REPORT: 'blue',
  COLOR_ERROR: 'red',
  COLOR_WARNING: 'orange',
} as const;
