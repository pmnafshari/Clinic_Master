/**
 * A chunk shorter than this is not treated as a finished sentence, so "Dr."
 * and "Mr." do not end one. Twelve characters is comfortably longer than any
 * common abbreviation and shorter than any sentence worth speaking alone.
 */
export const MIN_CHUNK_LENGTH = 12;

/**
 * Splits a reply into speakable chunks so synthesis can start on the first
 * sentence while the model is still producing the rest. That head start is
 * what makes the latency budget reachable — waiting for the whole reply before
 * speaking any of it puts a long pause on every turn.
 */
export function chunkSentences(text: string): string[] {
  if (text.trim().length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let buffer = '';

  // The terminator stays with the sentence it ends.
  for (const piece of text.trim().split(/(?<=[.!?])\s+/)) {
    buffer = buffer.length === 0 ? piece : `${buffer} ${piece}`;

    if (buffer.length >= MIN_CHUNK_LENGTH && /[.!?]$/.test(buffer)) {
      chunks.push(buffer);
      buffer = '';
    }
  }

  if (buffer.trim().length > 0) {
    chunks.push(buffer.trim());
  }

  return chunks;
}
