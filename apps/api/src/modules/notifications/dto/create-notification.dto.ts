import { IsString, IsOptional, IsEnum, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateNotificationDto {
  @ApiPropertyOptional({ example: 'patient-uuid' })
  @IsOptional()
  @IsString()
  patientId?: string;

  @ApiPropertyOptional({ example: 'user-uuid' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ enum: ['appointment_reminder', 'follow_up', 'treatment_update', 'payment_reminder', 'general'] })
  @IsEnum(['appointment_reminder', 'follow_up', 'treatment_update', 'payment_reminder', 'general'])
  type: string;

  @ApiProperty({ enum: ['email', 'sms', 'push'] })
  @IsEnum(['email', 'sms', 'push'])
  channel: string;

  @ApiProperty({ example: 'Appointment Reminder' })
  @IsString()
  subject: string;

  @ApiProperty({ example: 'You have an appointment tomorrow at 10:00 AM' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ example: '2024-03-14T10:00:00Z' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
