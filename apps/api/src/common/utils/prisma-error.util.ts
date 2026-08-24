import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Postgres SQLSTATEs for constraints Prisma does not model. */
const EXCLUSION_VIOLATION = '23P01';
const CHECK_VIOLATION = '23514';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}

/**
 * Turns a database failure into an HTTP error a client can act on.
 *
 * The status and the category travel — a duplicate is a 409, a missing record
 * is a 404 — because a caller needs those to respond sensibly. The database's
 * own words do not: `meta.target` names a constraint, `meta.field_name` names
 * a column, and Prisma's validation text names models and types. None of that
 * helps a legitimate caller, and together they describe the schema to anyone
 * probing for it.
 *
 * The detail is not lost. It reaches the server log through the global
 * exception filter, where only an operator can read it.
 */
export function handlePrismaError(error: unknown): never {
  // Exclusion and check constraints are enforced by the database but are not
  // part of the Prisma schema, so they arrive without a mapped error code.
  const message = messageOf(error);

  if (message.includes(EXCLUSION_VIOLATION) || message.includes('exclusion constraint')) {
    throw new ConflictException('That time slot conflicts with an existing appointment');
  }

  if (message.includes(CHECK_VIOLATION) || message.includes('check constraint')) {
    throw new BadRequestException('A field was set to a value the database does not allow');
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        throw new ConflictException(
          'A record with the same value already exists',
        );
      case 'P2003':
        throw new BadRequestException(
          'A related record was not found',
        );
      case 'P2014':
        throw new BadRequestException(
          'Required relation not found. Please provide all required related records.',
        );
      case 'P2025':
        throw new NotFoundException('Record not found');
      case 'P2000':
        throw new BadRequestException(
          'A value provided is too long',
        );
      case 'P2001':
        throw new NotFoundException('Record not found');
      case 'P2012':
        throw new BadRequestException(
          'A required value is missing',
        );
      case 'P2013':
        throw new BadRequestException(
          'A required argument is missing',
        );
      default:
        throw new BadRequestException('The request could not be completed');
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
    throw new BadRequestException('Invalid data provided');
  }

  throw error;
}
