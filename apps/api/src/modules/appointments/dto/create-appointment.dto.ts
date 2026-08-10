import { IsString, IsDateString, IsOptional, IsEnum, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAppointmentDto {
  @ApiProperty({ example: 'patient-uuid' })
  @IsString({ message: 'Patient is required' })
  patientId: string;

  @ApiProperty({ example: 'provider-uuid' })
  @IsString({ message: 'Provider is required' })
  providerId: string;

  @ApiProperty({ example: '2024-03-15T10:00:00Z' })
  @IsDateString({}, { message: 'Start time must be a valid date' })
  startTime: string;

  @ApiProperty({ example: '2024-03-15T11:00:00Z' })
  @IsDateString({}, { message: 'End time must be a valid date' })
  endTime: string;

  @ApiPropertyOptional({ enum: ['scheduled', 'confirmed'] })
  @IsOptional()
  @IsEnum(['scheduled', 'confirmed'], { message: 'Status must be scheduled or confirmed' })
  status?: string;

  @ApiPropertyOptional({ example: 'Chair 3' })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: 'Chair number must be at most 20 characters' })
  chairNumber?: string;

  @ApiPropertyOptional({ example: 'Regular checkup' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Reason must be at most 500 characters' })
  reason?: string;

  @ApiPropertyOptional({ example: 'Patient requested morning slot' })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Notes must be at most 1000 characters' })
  notes?: string;

  @ApiPropertyOptional({ example: 'treatment-plan-uuid' })
  @IsOptional()
  @IsString()
  treatmentPlanId?: string;
}
