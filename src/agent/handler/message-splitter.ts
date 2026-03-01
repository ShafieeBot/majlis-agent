/**
 * Message Splitter — Splits long responses into Telegram-friendly chunks.
 *
 * Strategy (in order of preference):
 * 1. Split at paragraph boundaries (\n\n)
 * 2. Split at newline boundaries (\n)
 * 3. Split at sentence boundaries (. ! ?)
 * 4. Hard cut at maxLen
 */

const DEFAULT_MAX_LEN = 3000;

/**
 * Split a message into chunks that fit within the max length.
 * Returns an array of strings, each ≤ maxLen.
 */
export function splitMessage(text: string, maxLen: number = DEFAULT_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try paragraph split
    let splitIdx = findLastSplitPoint(remaining, '\n\n', maxLen);

    // Try newline split
    if (splitIdx === -1) {
      splitIdx = findLastSplitPoint(remaining, '\n', maxLen);
    }

    // Try sentence split
    if (splitIdx === -1) {
      splitIdx = findLastSentenceSplit(remaining, maxLen);
    }

    // Hard cut
    if (splitIdx === -1) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Find the last occurrence of a delimiter before maxLen.
 */
function findLastSplitPoint(text: string, delimiter: string, maxLen: number): number {
  const searchIn = text.slice(0, maxLen);
  const idx = searchIn.lastIndexOf(delimiter);
  if (idx <= 0) return -1;
  return idx + delimiter.length;
}

/**
 * Find the last sentence-ending punctuation before maxLen.
 */
function findLastSentenceSplit(text: string, maxLen: number): number {
  const searchIn = text.slice(0, maxLen);
  // Look for sentence endings: period, exclamation, question mark followed by space
  const matches = [...searchIn.matchAll(/[.!?]\s/g)];
  if (matches.length === 0) return -1;

  const lastMatch = matches[matches.length - 1];
  return (lastMatch.index ?? 0) + lastMatch[0].length;
}
