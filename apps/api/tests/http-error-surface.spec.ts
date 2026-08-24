import {
  BadRequestException,
  Controller,
  HttpException,
  Get,
  INestApplication,
  Logger,
  NotFoundException,
  Post,
  Body,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import * as request from 'supertest';
import { Prisma } from '@prisma/client';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

class ThingDto {
  @IsString()
  name!: string;
}

/** Each route throws one representative failure the filter must contain. */
@Controller('probe')
class ProbeController {
  @Get('db-unreachable')
  dbUnreachable(): never {
    // What Prisma actually raises when Postgres is down — names host and port.
    throw new Prisma.PrismaClientInitializationError(
      "Can't reach database server at `localhost:5432`",
      '5.10.0'
    );
  }

  @Get('db-constraint')
  dbConstraint(): never {
    // A Prisma error that escaped handlePrismaError — names the column.
    throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.10.0',
      meta: { target: ['users_email_key'] },
    });
  }

  @Get('provider')
  provider(): never {
    throw new Error('Deepgram: 401 Unauthorized (project 9f2a)');
  }

  @Get('secret')
  secret(): never {
    throw new Error('auth failed with xi-api-key sk_live_abc123def456 rejected');
  }

  @Get('socket')
  socket(): never {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
  }

  @Get('non-error')
  nonError(): never {
    throw 'a bare string carrying internal detail: DATABASE_URL=postgres://u:p@h/db';
  }

  @Get('wrapped')
  wrapped(): never {
    // An HttpException whose body carries no message field. Falling back to
    // exception.message here reaches for whatever a wrapping layer left there.
    throw new HttpException({ statusCode: 502, detail: 'upstream ECONNREFUSED 10.0.0.5:5432' }, 502);
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundException('Patient not found');
  }

  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException('Appointment must end after it starts');
  }

  @Post('validated')
  validated(@Body() dto: ThingDto): { ok: true } {
    void dto;
    return { ok: true };
  }
}

const FORBIDDEN =
  /localhost:5432|ECONNREFUSED|10\.0\.0\.5|Deepgram|401|9f2a|sk_live|xi-api-key|P2002|users_email_key|DATABASE_URL|postgres:\/\/|PrismaClient|at Object\.|\.ts:\d+/i;

describe('the HTTP error surface tells a client nothing it should not know', () => {
  let app: INestApplication;
  let logged: string[];
  let spy: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logged = [];
    spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((m) => {
      logged.push(String(m));
    });
  });

  afterEach(() => spy.mockRestore());

  it.each([
    ['a database that is unreachable', 'db-unreachable'],
    ['a database constraint violation', 'db-constraint'],
    ['a provider rejection', 'provider'],
    ['an error carrying a credential', 'secret'],
    ['a socket failure', 'socket'],
    ['a thrown non-error', 'non-error'],
  ])('says only "Internal server error" for %s', async (_label, route) => {
    const res = await request(app.getHttpServer()).get(`/probe/${route}`).expect(500);

    expect(res.body.message).toBe('Internal server error');
    expect(res.body.messages).toEqual(['Internal server error']);
    expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
  });

  it('keeps the detail server-side rather than discarding it', async () => {
    await request(app.getHttpServer()).get('/probe/provider').expect(500);

    // The operator can still diagnose; the client simply is not told.
    expect(logged.join('\n')).toContain('Deepgram: 401 Unauthorized');
  });

  it('returns a stable, minimal shape with no extra fields', async () => {
    const res = await request(app.getHttpServer()).get('/probe/socket').expect(500);

    expect(Object.keys(res.body).sort()).toEqual([
      'message', 'messages', 'path', 'statusCode', 'timestamp',
    ]);
    // No stack, no cause, no error name.
    expect(res.body).not.toHaveProperty('stack');
    expect(res.body).not.toHaveProperty('error');
  });

  it('preserves intended statuses and messages for deliberate failures', async () => {
    const notFound = await request(app.getHttpServer()).get('/probe/not-found').expect(404);
    expect(notFound.body.message).toBe('Patient not found');

    const bad = await request(app.getHttpServer()).get('/probe/bad-request').expect(400);
    expect(bad.body.message).toBe('Appointment must end after it starts');
  });

  it('still returns validation detail, which the caller needs to fix their request', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/validated')
      .send({ name: 42, sneaky: 'x' })
      .expect(400);

    expect(res.body.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
  });

  it('does not fall back to exception.message when an HttpException has no message', async () => {
    const res = await request(app.getHttpServer()).get('/probe/wrapped').expect(502);

    // The status is the application's intent and is kept; the body is not a
    // message this application authored, so it does not travel.
    expect(res.body.message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
  });

  it('does not echo the query string, which can carry a token', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/socket?ticket=one-time-secret&token=abc123')
      .expect(500);

    expect(res.body.path).toBe('/probe/socket');
    expect(JSON.stringify(res.body)).not.toContain('one-time-secret');
    expect(JSON.stringify(res.body)).not.toContain('abc123');
  });
});
