export type InteractionPromptMessage = Readonly<{
  role: string;
  content: string;
}>;

/** Shared prompt construction used by the real and simplified Interaction paths. */
export function buildInteractionPrompt(input: {
  history: readonly InteractionPromptMessage[];
  currentMessage: string;
  mediaError?: string;
  proactive?: boolean;
}): string {
  const userText = input.mediaError
    ? `[user sent images but they couldn't be downloaded: ${input.mediaError}]\n${input.currentMessage}`
    : input.currentMessage;
  if (input.proactive) {
    return `Standalone proactive notice. Write a concise user-facing iMessage from this notice only. Do not research, spawn agents, or continue any prior conversation.\n\n${userText}`;
  }
  const historyBlock = input.history
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  return historyBlock
    ? `Prior turns:\n${historyBlock}\n\nCurrent message:\n${userText}`
    : userText;
}
