import { IsString, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The sessionId is untrusted client input and reaches an in-memory session
 * store and an idempotency key. The charset is restricted rather than merely
 * length-bounded, so no accepted value can contain the ':' key separator, the
 * '%' escape, a path segment, whitespace, or a control character.
 *
 * A UUID satisfies this, as does any ordinary opaque identifier.
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
  @ApiProperty({ example: 'sess-abc123', pattern: '^[A-Za-z0-9_-]{1,64}$' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(SESSION_ID_PATTERN, {
    message:
      'sessionId must be 1 to 64 characters of A-Z, a-z, 0-9, hyphen or underscore',
  })
  sessionId: string;

  @ApiProperty({ example: 'What time do you open on Monday?', maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;
}
