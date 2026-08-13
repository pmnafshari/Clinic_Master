import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches } from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

/**
 * Shape check only. The sessionId is untrusted client input, and passing this
 * pattern grants nothing: the server resumes a conversation only when the value
 * matches an id it issued itself and still holds. An id the server does not
 * recognise is never adopted — a fresh session is minted instead.
 *
 * The charset also happens to exclude the ':' idempotency-key separator and the
 * '%' escape, which keeps the key encoding unambiguous.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Note what is NOT here: userId, patientId, identityVerified, tier and
 * turnIndex are all server-owned. They are absent from this DTO, so the global
 * ValidationPipe (whitelist + forbidNonWhitelisted) rejects them, and the
 * controller never reads a field it was not given — the endpoint tests assert
 * both, so neither control depends on the other.
 */
export class VoiceTextDto {
  /**
   * Omitted on first contact — the server issues one and returns it. On later
   * turns, echo back the sessionId the server returned. Sending anything else
   * simply starts a new conversation; it never joins an existing one.
   */
  @ApiPropertyOptional({
    description:
      'Omit on first contact. On later turns, echo the sessionId returned by the server.',
    pattern: '^[A-Za-z0-9_-]{1,64}$',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(SESSION_ID_PATTERN, {
    message:
      'sessionId must be 1 to 64 characters of A-Z, a-z, 0-9, hyphen or underscore',
  })
  sessionId?: string;

  @ApiProperty({ example: 'What time do you open on Monday?', maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;
}
