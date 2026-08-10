import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateChartDto {
  @ApiProperty({ example: 'patient-uuid' })
  @IsString({ message: 'Patient is required' })
  patientId: string;

  @ApiPropertyOptional({ example: 'appointment-uuid' })
  @IsOptional()
  @IsString()
  appointmentId?: string;

  @ApiProperty({ example: 'provider-uuid' })
  @IsString({ message: 'Provider is required' })
  providerId: string;

  @ApiPropertyOptional({ example: 'Patient presents with mild sensitivity on tooth #14' })
  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: 'Clinical notes must be at most 5000 characters' })
  clinicalNotes?: string;
}
