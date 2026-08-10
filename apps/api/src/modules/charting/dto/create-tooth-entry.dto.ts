import { IsString, IsNumber, IsOptional, IsEnum, Min, Max, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateToothEntryDto {
  @ApiProperty({ example: 14 })
  @IsNumber({}, { message: 'Tooth number is required' })
  @Min(11, { message: 'Tooth number must be between 11 and 48 (FDI notation)' })
  @Max(48, { message: 'Tooth number must be between 11 and 48 (FDI notation)' })
  toothNumber: number;

  @ApiPropertyOptional({ example: 'MO' })
  @IsOptional()
  @IsString()
  @MaxLength(10, { message: 'Surface must be at most 10 characters' })
  surface?: string;

  @ApiProperty({ example: 'cavity' })
  @IsString({ message: 'Condition is required' })
  @MaxLength(50, { message: 'Condition must be at most 50 characters' })
  condition: string;

  @ApiPropertyOptional({ example: 'filling' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Procedure must be at most 100 characters' })
  procedure?: string;

  @ApiPropertyOptional({ enum: ['planned', 'completed', 'in-progress'] })
  @IsOptional()
  @IsEnum(['planned', 'completed', 'in-progress'], {
    message: 'Status must be planned, completed, or in-progress',
  })
  status?: string;

  @ApiPropertyOptional({ example: 'Small cavity detected' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Notes must be at most 500 characters' })
  notes?: string;
}
