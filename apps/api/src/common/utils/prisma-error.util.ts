import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export function handlePrismaError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        throw new ConflictException(
          `A record with the same value already exists: ${error.meta?.target || 'unique constraint'}`,
        );
      case 'P2003':
        throw new BadRequestException(
          `Related record not found: ${error.meta?.field_name || 'foreign key constraint'}`,
        );
      case 'P2014':
        throw new BadRequestException(
          'Required relation not found. Please provide all required related records.',
        );
      case 'P2025':
        throw new NotFoundException('Record not found');
      case 'P2000':
        throw new BadRequestException(
          `Invalid input: ${error.meta?.message || 'value too long for column'}`,
        );
      case 'P2001':
        throw new NotFoundException('Record not found');
      case 'P2012':
        throw new BadRequestException(
          `Missing required value: ${error.meta?.message || 'missing value'}`,
        );
      case 'P2013':
        throw new BadRequestException(
          `Missing required argument: ${error.meta?.message || 'missing argument'}`,
        );
      default:
        throw new BadRequestException(`Database error: ${error.code}`);
    }
  }

  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    throw new BadRequestException('An unexpected database error occurred');
  }

  if (error instanceof Prisma.PrismaClientRustPanicError) {
    throw new BadRequestException('A critical database error occurred');
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    throw new BadRequestException('Failed to connect to the database');
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    throw new BadRequestException(`Invalid data provided: ${error.message.split('\n').pop()}`);
  }

  throw error;
}
