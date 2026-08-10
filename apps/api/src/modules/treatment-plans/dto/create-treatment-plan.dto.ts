import { IsString, IsOptional, IsNumber, IsArray, ValidateNested, IsEnum, Min, Max, MinLength, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTreatmentPlanItemDto {
  @ApiProperty({ example: 'D1120' })
  @IsString({ message: 'Procedure code is required' })
  @MaxLength(20, { message: 'Procedure code must be at most 20 characters' })
  procedureCode: string;

  @ApiProperty({ example: 'Composite filling - posterior' })
  @IsString({ message: 'Description is required' })
  @MaxLength(255, { message: 'Description must be at most 255 characters' })
  description: string;

  @ApiProperty({ example: 150.0 })
  @IsNumber({}, { message: 'Cost must be a number' })
  @Min(0.01, { message: 'Cost must be greater than $0.00' })
  @Max(1000000, { message: 'Cost must be at most $1,000,000' })
  cost: number;

  @ApiPropertyOptional({ enum: ['planned', 'approved', 'completed'] })
  @IsOptional()
  @IsEnum(['planned', 'approved', 'completed'], {
    message: 'Status must be planned, approved, or completed',
  })
  status?: string;

  @ApiPropertyOptional({ example: 14 })
  @IsOptional()
  @IsNumber({}, { message: 'Teeth involved must be a number' })
  @Min(11, { message: 'Tooth number must be between 11 and 48 (FDI notation)' })
  @Max(48, { message: 'Tooth number must be between 11 and 48 (FDI notation)' })
  teethInvolved?: number;

  @ApiPropertyOptional({ example: 'Small cavity on mesial surface' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Notes must be at most 500 characters' })
  notes?: string;
}

export class CreateTreatmentPlanDto {
  @ApiProperty({ example: 'patient-uuid' })
  @IsString({ message: 'Patient is required' })
  patientId: string;

  @ApiProperty({ example: 'provider-uuid' })
  @IsString({ message: 'Provider is required' })
  providerId: string;

  @ApiProperty({ example: 'Root Canal Treatment Plan' })
  @IsString({ message: 'Plan title is required' })
  @MinLength(3, { message: 'Plan title must be at least 3 characters' })
  @MaxLength(100, { message: 'Plan title must be at most 100 characters' })
  title: string;

  @ApiPropertyOptional({ example: 'Comprehensive treatment for tooth #14' })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Description must be at most 1000 characters' })
  description?: string;

  @ApiPropertyOptional({ example: 'planned' })
  @IsOptional()
  @IsEnum(['planned', 'approved', 'in-progress', 'completed', 'cancelled'], {
    message: 'Status must be planned, approved, in-progress, completed, or cancelled',
  })
  status?: string;

  @ApiPropertyOptional({ type: [CreateTreatmentPlanItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTreatmentPlanItemDto)
  items?: CreateTreatmentPlanItemDto[];
}
