import { HttpException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { handlePrismaError } from '../src/common/utils/prisma-error.util';

/** Metadata a real Prisma error carries, and that must never reach a client. */
const TARGET = 'users_email_key';
const FIELD = 'patients_user_id_fkey';
const RAW = 'value too long for type character varying(50) in column "phone"';

const FORBIDDEN = new RegExp(
  [TARGET, FIELD, 'character varying', 'column', 'constraint', 'fkey', 'P20\\d\\d', 'prisma'].join('|'),
  'i'
);

function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('internal prisma text', {
    code,
    clientVersion: '5.10.0',
    meta,
  });
}

/** Runs the mapper and returns what a client would actually receive. */
function clientSees(error: unknown): { status: number; message: string } {
  try {
    handlePrismaError(error);
  } catch (thrown) {
    if (thrown instanceof HttpException) {
      const res = thrown.getResponse();
      const message = typeof res === 'string' ? res : ((res as { message?: string }).message ?? '');
      return { status: thrown.getStatus(), message };
    }
    throw thrown;
  }
  throw new Error('handlePrismaError did not throw');
}

describe('database failures keep their category and lose their detail', () => {
  it.each([
    ['P2002 duplicate', known('P2002', { target: [TARGET] }), 409],
    ['P2003 foreign key', known('P2003', { field_name: FIELD }), 400],
    ['P2000 value too long', known('P2000', { message: RAW }), 400],
    ['P2012 missing value', known('P2012', { message: RAW }), 400],
    ['P2013 missing argument', known('P2013', { message: RAW }), 400],
    ['P2025 record not found', known('P2025'), 404],
    ['an unmapped code', known('P2099'), 400],
  ])('%s keeps its status and carries no metadata', (_label, error, expectedStatus) => {
    const { status, message } = clientSees(error);

    expect(status).toBe(expectedStatus);
    expect(message).not.toMatch(FORBIDDEN);
    // Still says something a caller can act on.
    expect(message.length).toBeGreaterThan(0);
  });

  it('does not leak Prisma validation text, which names models and types', () => {
    const error = new Prisma.PrismaClientValidationError(
      'Invalid `prisma.patient.create()` invocation:\nArgument phone: Got invalid value 42 on Patient',
      { clientVersion: '5.10.0' }
    );

    const { status, message } = clientSees(error);

    expect(status).toBe(400);
    expect(message).toBe('Invalid data provided');
    expect(message).not.toMatch(/prisma|patient|phone|invocation/i);
  });

  it('keeps the constraint messages the database does not model', () => {
    // These carry no metadata and are the most useful messages in the file:
    // a caller can act on "that slot conflicts" in a way they cannot act on
    // a constraint name.
    const exclusion = clientSees(new Error('conflicting key value violates exclusion constraint "no_overlap"'));
    expect(exclusion.status).toBe(409);
    expect(exclusion.message).toMatch(/time slot conflicts/i);

    const check = clientSees(new Error('new row violates check constraint "status_valid"'));
    expect(check.status).toBe(400);
    expect(check.message).toMatch(/value the database does not allow/i);
  });

  it('rethrows anything that is not a database error, untouched', () => {
    const other = new Error('not a prisma failure');
    expect(() => handlePrismaError(other)).toThrow(other);
  });

  it('leaves no interpolation of database metadata anywhere in the mapper', () => {
    const source = readFileSync(
      join(__dirname, '../src/common/utils/prisma-error.util.ts'),
      'utf8'
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Every thrown message is a literal. A template that reads error.meta,
    // error.code or error.message back into a response is the defect this
    // patch removed.
    expect(code).not.toMatch(/throw new \w+Exception\([^)]*\$\{/);
    expect(code).not.toMatch(/error\.meta/);
  });
});
