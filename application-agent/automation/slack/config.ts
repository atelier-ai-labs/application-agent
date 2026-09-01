export interface SlackEnvironment {
  ATELIER_SLACK_BOT_TOKEN?: string;
  ATELIER_SLACK_APP_TOKEN?: string;
  ATELIER_SLACK_CHANNEL_ID?: string;
  ATELIER_SLACK_ALLOWED_USER_ID?: string;
  ATELIER_SLACK_ALLOWED_TEAM_ID?: string;
  ATELIER_SLACK_API_BASE_URL?: string;
}

export interface SlackNotificationConfig {
  botToken: string;
  appToken: string;
  channelId: string;
  allowedUserId: string;
  allowedTeamId?: string;
  apiBaseUrl: string;
}

export class SlackConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackConfigurationError";
  }
}

function required(env: SlackEnvironment, key: keyof SlackEnvironment): string {
  const value = env[key]?.trim();
  if (!value) throw new SlackConfigurationError(`${key} is required to start the Career Agent Slack listener.`);
  return value;
}

function apiBaseUrl(value: string | undefined): string {
  const base = value?.trim() || "https://slack.com/api";
  try {
    const url = new URL(base);
    if (url.protocol !== "https:") throw new Error("unsupported protocol");
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new SlackConfigurationError("ATELIER_SLACK_API_BASE_URL must be an HTTPS URL.");
  }
}

export function resolveSlackConfig(env: SlackEnvironment): SlackNotificationConfig {
  const allowedTeamId = env.ATELIER_SLACK_ALLOWED_TEAM_ID?.trim() || undefined;
  return {
    botToken: required(env, "ATELIER_SLACK_BOT_TOKEN"),
    appToken: required(env, "ATELIER_SLACK_APP_TOKEN"),
    channelId: required(env, "ATELIER_SLACK_CHANNEL_ID"),
    allowedUserId: required(env, "ATELIER_SLACK_ALLOWED_USER_ID"),
    ...(allowedTeamId ? { allowedTeamId } : {}),
    apiBaseUrl: apiBaseUrl(env.ATELIER_SLACK_API_BASE_URL),
  };
}
