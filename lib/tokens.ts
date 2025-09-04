/**
 * Token estimation and text truncation utilities
 * Uses character-based approximation (~4 chars per token)
 * Provides head+tail truncation for preserving important content
 */

export function estimateTokens(s: string): number {
  // Fast rough estimation: ~4 characters per token for English text
  // This works well enough for budget calculations and is much faster than actual tokenization
  const approxCharsPerToken = 4;
  return Math.ceil((s || '').length / approxCharsPerToken);
}

export function headTailSlice(
  text: string,
  maxTokens: number,
  headRatio = 0.75
): string {
  if (!text) return text;

  const estimatedTokens = estimateTokens(text);
  if (estimatedTokens <= maxTokens) return text;

  // Reserve some tokens for the "...TRUNCATED..." marker
  const availableTokens = Math.max(32, maxTokens - 8);
  const headTokenCount = Math.max(16, Math.floor(availableTokens * headRatio));
  const tailTokenCount = Math.max(8, availableTokens - headTokenCount);

  // Convert token counts to approximate character counts
  const approxCharsPerToken = 4;
  const headCharCount = headTokenCount * approxCharsPerToken;
  const tailCharCount = tailTokenCount * approxCharsPerToken;

  const head = text.slice(0, headCharCount);
  const tail = text.slice(-tailCharCount);

  // Clean up the tail to avoid cutting in the middle of words/sentences
  const cleanTail = tail.replace(/^[^\n]*$/, match => {
    // Try to find a good break point (sentence, then word boundary)
    const sentenceBreak = match.search(/[.!?]\s/);
    if (sentenceBreak > match.length * 0.3) {
      return match.slice(0, sentenceBreak + 1);
    }
    const wordBreak = match.search(/\s/);
    if (wordBreak > match.length * 0.5) {
      return match.slice(0, wordBreak);
    }
    return match;
  });

  return `${head.trim()}\n\n[...content truncated...]\n\n${cleanTail.trim()}`;
}

// More precise token counting if we want to upgrade later
export function countWords(text: string): number {
  return (text || '')
    .trim()
    .split(/\s+/)
    .filter(word => word.length > 0).length;
}

export function estimateTokensFromWords(wordCount: number): number {
  // Rough: 1.3 tokens per word on average
  return Math.ceil(wordCount * 1.3);
}
