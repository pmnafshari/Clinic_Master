import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Patients (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let patientId: string;

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
  });

  afterAll(async () => {
    await app.close();
  });

  describe('/api/patients (GET)', () => {
    it('should return list of patients', () => {
      return request(app.getHttpServer())
        .get('/api/patients')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('data');
          expect(res.body).toHaveProperty('pagination');
          expect(Array.isArray(res.body.data)).toBe(true);
        });
    });

    it('should reject unauthenticated request', () => {
      return request(app.getHttpServer())
        .get('/api/patients')
        .expect(401);
    });
  });

  describe('/api/patients (POST)', () => {
    it('should create a new patient', () => {
      const uniqueEmail = `john.doe.test${Date.now()}@example.com`;
      return request(app.getHttpServer())
        .post('/api/patients')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          firstName: 'John',
          lastName: 'Doe',
          phone: '555-0101234',
          dateOfBirth: '1990-01-15',
          email: uniqueEmail,
        })
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('id');
          expect(res.body.firstName).toBe('John');
          patientId = res.body.id;
        });
    });

    it('should validate required fields', () => {
      return request(app.getHttpServer())
        .post('/api/patients')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          firstName: 'J',
        })
        .expect(400);
    });
  });

  describe('/api/patients/:id (GET)', () => {
    it('should return patient by id', () => {
      return request(app.getHttpServer())
        .get(`/api/patients/${patientId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.id).toBe(patientId);
          expect(res.body.firstName).toBe('John');
        });
    });

    it('should return 404 for non-existent patient', () => {
      return request(app.getHttpServer())
        .get('/api/patients/non-existent-id')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  describe('/api/patients/:id (PATCH)', () => {
    it('should update patient', () => {
      return request(app.getHttpServer())
        .patch(`/api/patients/${patientId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          phone: '555-1234567',
        })
        .expect(200)
        .expect((res) => {
          expect(res.body.phone).toBe('555-1234567');
        });
    });
  });
});
