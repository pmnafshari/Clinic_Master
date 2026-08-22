import { chunkSentences, MIN_CHUNK_LENGTH } from '../../src/modules/voice/speech/sentence-chunker';

describe('sentence chunker', () => {
  it('pins the minimum chunk length to a literal', () => {
    expect(MIN_CHUNK_LENGTH).toBe(12);
  });

  it('splits on sentence boundaries', () => {
    expect(chunkSentences('We open at eight. We close at six.')).toEqual([
      'We open at eight.',
      'We close at six.',
    ]);
  });

  it('does not fragment on an abbreviation', () => {
    expect(chunkSentences('Dr. Chen can see you at nine.')).toEqual([
      'Dr. Chen can see you at nine.',
    ]);
  });

  it('handles question and exclamation marks', () => {
    expect(chunkSentences('Can you come Tuesday? Great!')).toEqual([
      'Can you come Tuesday?',
      'Great!',
    ]);
  });

  it('flushes a trailing fragment with no terminator', () => {
    expect(chunkSentences('We open at eight. And then')).toEqual([
      'We open at eight.',
      'And then',
    ]);
  });

  it('returns nothing for empty or whitespace input', () => {
    expect(chunkSentences('')).toEqual([]);
    expect(chunkSentences('   ')).toEqual([]);
    expect(chunkSentences('\n\t')).toEqual([]);
  });

  it('keeps a single sentence whole', () => {
    expect(chunkSentences('We are open eight to six.')).toEqual(['We are open eight to six.']);
  });

  it('loses no text across the split', () => {
    const reply =
      'Thanks Dana. Your appointment is confirmed for Tuesday at ten past two. ' +
      'Please arrive ten minutes early. Is there anything else?';
    const chunks = chunkSentences(reply);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(reply.trim());
  });

  it('emits the first sentence before the rest, so audio can start early', () => {
    const chunks = chunkSentences('We open at eight. We close at six. Parking is free.');
    expect(chunks[0]).toBe('We open at eight.');
    expect(chunks).toHaveLength(3);
  });
});
