import { IsEmail, IsString, MinLength, MaxLength, IsOptional, IsDateString, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePatientDto {
  @ApiProperty({ example: 'John' })
  @IsString({ message: 'First name is required' })
  @MinLength(2, { message: 'First name must be at least 2 characters' })
  @MaxLength(50, { message: 'First name must be at most 50 characters' })
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString({ message: 'Last name is required' })
  @MinLength(2, { message: 'Last name must be at least 2 characters' })
  @MaxLength(50, { message: 'Last name must be at most 50 characters' })
  lastName: string;

  @ApiPropertyOptional({ example: 'john.doe@example.com' })
  @IsOptional()
  @IsEmail({}, { message: 'Please enter a valid email address' })
  @MaxLength(254, { message: 'Email must be at most 254 characters' })
  email?: string;

  @ApiProperty({ example: '+1234567890' })
  @IsString({ message: 'Phone number is required' })
  @MinLength(10, { message: 'Phone number must be at least 10 characters' })
  @MaxLength(20, { message: 'Phone number must be at most 20 characters' })
  phone: string;

  @ApiProperty({ example: '1990-01-15' })
  @IsDateString({}, { message: 'Please enter a valid date of birth (YYYY-MM-DD)' })
  dateOfBirth: string;

  @ApiPropertyOptional({ enum: ['male', 'female', 'other'] })
  @IsOptional()
  @IsEnum(['male', 'female', 'other'], { message: 'Gender must be male, female, or other' })
  gender?: string;

  @ApiPropertyOptional({ example: '123 Main St, City, State 12345' })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Address must be at most 255 characters' })
  address?: string;

  @ApiPropertyOptional({ example: 'Jane Doe' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Emergency contact name must be at most 100 characters' })
  emergencyContact?: string;

  @ApiPropertyOptional({ example: '+1987654321' })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: 'Emergency phone must be at most 20 characters' })
  emergencyPhone?: string;

  @ApiPropertyOptional({ example: 'No known conditions' })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Medical history must be at most 2000 characters' })
  medicalHistory?: string;

  @ApiPropertyOptional({ example: 'Previous root canal on tooth #12' })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Dental history must be at most 2000 characters' })
  dentalHistory?: string;

  @ApiPropertyOptional({ example: 'Penicillin' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Allergies must be at most 500 characters' })
  allergies?: string;

  @ApiPropertyOptional({ example: 'Regular checkup patient' })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Notes must be at most 2000 characters' })
  notes?: string;
}
