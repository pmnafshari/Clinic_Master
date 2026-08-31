import { IsDateString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The reporting endpoints turn these straight into `new Date(...)` and hand the
 * result to Prisma. An absent or unparseable value became `Invalid Date`, which
 * Prisma rejected as a validation error and the filter reported as a 500 — a
 * caller's mistake surfacing as a server fault.
 *
 * Validating here stops that at the edge: the global ValidationPipe rejects a
 * bad range with a 400 before any query is built.
 */
export class DateRangeDto {
  @ApiProperty({ example: '2026-01-01', description: 'Start of the range, ISO 8601.' })
  @IsDateString({}, { message: 'startDate must be a valid ISO 8601 date' })
  startDate: string;

  @ApiProperty({ example: '2026-12-31', description: 'End of the range, ISO 8601.' })
  @IsDateString({}, { message: 'endDate must be a valid ISO 8601 date' })
  endDate: string;
}

/**
 * The dashboard defaults to the current month when a bound is omitted, so both
 * are optional — but a value that *is* supplied still has to be a real date.
 */
export class OptionalDateRangeDto {
  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsDateString({}, { message: 'startDate must be a valid ISO 8601 date' })
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsDateString({}, { message: 'endDate must be a valid ISO 8601 date' })
  endDate?: string;
}
