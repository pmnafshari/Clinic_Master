import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Appointments (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let patientId: string;
  let providerId: string;
  let appointmentId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      })
    );
    await app.init();

    // Get admin token
    const loginRes = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({
        email: 'admin@smileflow.com',
        password: 'password123',
      });
    adminToken = loginRes.body.accessToken;

    // Get a patient
    const patientsRes = await request(app.getHttpServer())
      .get('/api/patients')
      .set('Authorization', `Bearer ${adminToken}`);
    patientId = patientsRes.body.data[0]?.id;

    // Get a provider (dentist)
    const usersRes = await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);
    providerId = usersRes.body.find((u: any) => u.role?.name === 'dentist')?.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('/api/appointments (POST)', () => {
    it('should create a new appointment', () => {
      const startTime = new Date();
      startTime.setDate(startTime.getDate() + 7);
      startTime.setHours(10, 0, 0, 0);
      
      const endTime = new Date(startTime);
      endTime.setHours(11, 0, 0, 0);

      return request(app.getHttpServer())
        .post('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          patientId,
          providerId,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          reason: 'Regular checkup',
        })
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('id');
          expect(res.body.status).toBe('scheduled');
          appointmentId = res.body.id;
        });
    });

    it('should prevent overlapping appointments', async () => {
      const startTime = new Date();
      startTime.setDate(startTime.getDate() + 7);
      startTime.setHours(10, 30, 0, 0);
      
      const endTime = new Date(startTime);
      endTime.setHours(11, 30, 0, 0);

      return request(app.getHttpServer())
        .post('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          patientId,
          providerId,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        })
        .expect(409);
    });
  });

  describe('/api/appointments (GET)', () => {
    it('should return list of appointments', () => {
      return request(app.getHttpServer())
        .get('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe('/api/appointments/:id/status (PATCH)', () => {
    it('should update appointment status', () => {
      return request(app.getHttpServer())
        .patch(`/api/appointments/${appointmentId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          status: 'confirmed',
        })
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('confirmed');
        });
    });
  });

  describe('/api/appointments/:id (DELETE)', () => {
    it('should cancel appointment', () => {
      return request(app.getHttpServer())
        .delete(`/api/appointments/${appointmentId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('cancelled');
        });
    });
  });

  describe('double-booking under concurrency', () => {
    // Every booking made here is cancelled afterwards. The exclusion
    // constraint ignores cancelled rows, so this frees the slot and keeps the
    // suite repeatable against a database that is not reset between runs.
    const createdIds: string[] = [];

    const slot = (dayOffset: number, hour: number) => {
      const start = new Date();
      start.setDate(start.getDate() + dayOffset);
      start.setHours(hour, 0, 0, 0);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      return { startTime: start.toISOString(), endTime: end.toISOString() };
    };

    const book = async (times: { startTime: string; endTime: string }) => {
      const res = await request(app.getHttpServer())
        .post('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ patientId, providerId, ...times });
      if (res.body?.id) createdIds.push(res.body.id);
      return res;
    };

    afterAll(async () => {
      await Promise.all(
        createdIds.map((id) =>
          request(app.getHttpServer())
            .delete(`/api/appointments/${id}`)
            .set('Authorization', `Bearer ${adminToken}`)
        )
      );
    });

    it('accepts only one of two simultaneous bookings for the same slot', async () => {
      const times = slot(21, 9);

      // Both requests check availability before either commits. Without the
      // serializable transaction and the exclusion constraint, both succeed.
      const results = await Promise.allSettled([book(times), book(times)]);

      const created = results.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 201
      );
      expect(created).toHaveLength(1);

      const listed = await request(app.getHttpServer())
        .get('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ providerId });

      const overlapping = listed.body.filter(
        (a: { startTime: string; status: string }) =>
          a.status !== 'cancelled' && a.startTime === times.startTime
      );
      expect(overlapping).toHaveLength(1);
    });

    it('allows a back-to-back booking that only touches at the boundary', async () => {
      const first = slot(22, 9);
      const second = {
        startTime: first.endTime,
        endTime: new Date(new Date(first.endTime).getTime() + 30 * 60 * 1000).toISOString(),
      };

      expect((await book(first)).status).toBe(201);
      expect((await book(second)).status).toBe(201);
    });

    it('rejects an appointment that ends before it starts', async () => {
      const times = slot(23, 9);
      await request(app.getHttpServer())
        .post('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ patientId, providerId, startTime: times.endTime, endTime: times.startTime })
        .expect(400);
    });
  });
});
