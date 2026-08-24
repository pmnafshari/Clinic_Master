import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { WsOriginAdapter } from '../src/modules/voice/transport/ws-origin.adapter';

describe('Security (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let adminId: string;
  let patientToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // The voice module now registers a WebSocket gateway, so an adapter is
    // required before init — exactly as main.ts does it.
    app.useWebSocketAdapter(new WsOriginAdapter(app));
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      })
    );
    await app.init();

    const adminLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@smileflow.com', password: 'password123' });
    adminToken = adminLogin.body.accessToken;
    adminId = adminLogin.body.user.id;

    const patientLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'john.doe@example.com', password: 'password123' });
    patientToken = patientLogin.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('passwordHash exposure', () => {
    it('should NOT expose passwordHash in /auth/me', () => {
      return request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).not.toHaveProperty('passwordHash');
          expect(res.body.email).toBe('admin@smileflow.com');
        });
    });

    it('should NOT expose passwordHash in /users list', () => {
      return request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          for (const user of res.body) {
            expect(user).not.toHaveProperty('passwordHash');
          }
        });
    });

    it('should NOT expose passwordHash in /users/:id', () => {
      return request(app.getHttpServer())
        .get(`/api/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).not.toHaveProperty('passwordHash');
          expect(res.body.role?.name).toBe('admin');
        });
    });
  });

  describe('RBAC on /users', () => {
    it('should deny patient access to /users list (403)', () => {
      return request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(403);
    });

    it('should deny patient access to /users/:id (403)', () => {
      return request(app.getHttpServer())
        .get(`/api/users/${adminId}`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(403);
    });
  });

  describe('notifications ownership', () => {
    it('should deny patient reading another patient notification (403)', async () => {
      const profile = await request(app.getHttpServer())
        .get('/api/portal/profile')
        .set('Authorization', `Bearer ${patientToken}`);
      const myPatientId = profile.body.id;

      const patients = await request(app.getHttpServer())
        .get('/api/patients')
        .set('Authorization', `Bearer ${adminToken}`);
      const otherPatient = patients.body.data.find((p: any) => p.id !== myPatientId);

      const created = await request(app.getHttpServer())
        .post('/api/notifications')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          patientId: otherPatient.id,
          type: 'general',
          channel: 'email',
          subject: 'Security test',
          content: 'Should not be visible to other patients',
        })
        .expect(201);

      const notificationId = created.body.id;

      await request(app.getHttpServer())
        .get(`/api/notifications/${notificationId}`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .patch(`/api/notifications/${notificationId}/read`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .delete(`/api/notifications/${notificationId}`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(403);
    });

    it('should deny patient creating notifications (403)', () => {
      return request(app.getHttpServer())
        .post('/api/notifications')
        .set('Authorization', `Bearer ${patientToken}`)
        .send({
          type: 'general',
          channel: 'email',
          subject: 'Hijack',
          content: 'spam',
        })
        .expect(403);
    });

    it('should allow patient reading their own notifications (200)', () => {
      return request(app.getHttpServer())
        .get('/api/notifications')
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe('isActive enforcement', () => {
    it('should reject login for deactivated users', async () => {
      const users = await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${adminToken}`);
      const adminRoleId = users.body[0].role.id;

      const email = `deactivate${Date.now()}@example.com`;
      const created = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email,
          firstName: 'To',
          lastName: 'Deactivate',
          password: 'password123',
          roleId: adminRoleId,
        })
        .expect(201);

      const createdId = created.body.id;

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email, password: 'password123' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/users/${createdId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email, password: 'password123' })
        .expect(401);
    });
  });

  describe('password policy', () => {
    it('should reject registration with short password (400)', () => {
      return request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          firstName: 'Short',
          lastName: 'Password',
          email: `short${Date.now()}@example.com`,
          password: 'short1',
        })
        .expect(400);
    });
  });

  describe('reports access (admin + receptionist)', () => {
    it('should allow receptionist access to all report endpoints (200)', async () => {
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'receptionist@smileflow.com', password: 'password123' });
      const token = login.body.accessToken;

      await request(app.getHttpServer())
        .get('/api/reports/dashboard')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/reports/revenue?startDate=2020-01-01&endDate=2030-01-01')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/reports/appointments?startDate=2020-01-01&endDate=2030-01-01')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/reports/treatments?startDate=2020-01-01&endDate=2030-01-01')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/reports/patients?startDate=2020-01-01&endDate=2030-01-01')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('byMonth');
        });
    });

    it('should deny patient access to report endpoints (403)', () => {
      return request(app.getHttpServer())
        .get('/api/reports/dashboard')
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(403);
    });
  });
});
