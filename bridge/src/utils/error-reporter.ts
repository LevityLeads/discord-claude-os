import type { Client, TextChannel } from "discord.js";

/**
 * Error reporter for Discord bridge runtime errors.
 *
 * Opt-in via the KERN_ERROR_CHANNEL_ID env var. When set, runtime errors
 * caught by top-level handlers are posted to that channel with their real
 * stack trace, so they don't disappear into Railway logs while the user
 * only sees a generic "An error occurred" reply.
 *
 * If the env var is unset (or the channel cannot be fetched), this is a
 * no-op beyond the existing console.error the caller already did.
 */

const MAX_DISCORD_MESSAGE = 1900;

export async function reportError(
  client: Client,
  context: string,
  error: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  const channelId = process.env.KERN_ERROR_CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;

    const err = error instanceof Error ? error : new Error(String(error));
    const stack = err.stack ?? err.message;
    const extraStr = extra && Object.keys(extra).length > 0
      ? `\n\n**Context:**\n\`\`\`json\n${JSON.stringify(extra, null, 2)}\n\`\`\``
      : "";

    const body = [
      `🚨 **${context}**`,
      `\`${err.name}: ${err.message}\``,
      "```",
      stack.slice(0, MAX_DISCORD_MESSAGE - 200),
      "```",
      extraStr,
    ].join("\n");

    await (channel as TextChannel).send({
      content: body.slice(0, MAX_DISCORD_MESSAGE),
      allowedMentions: { parse: [] },
    });
  } catch (reportErr) {
    // Never let the reporter itself throw -- we don't want to mask the
    // original error or kick off a loop if the error channel is broken.
    console.warn(
      "[error-reporter] Failed to post error to Discord:",
      reportErr instanceof Error ? reportErr.message : reportErr,
    );
  }
}
