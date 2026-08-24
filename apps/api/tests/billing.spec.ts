import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { WsOriginAdapter } from '../src/modules/voice/transport/ws-origin.adapter';

describe('Billing (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let patientId: string;

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

    const loginRes = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@smileflow.com', password: 'password123' });
    adminToken = loginRes.body.accessToken;

    const patientsRes = await request(app.getHttpServer())
      .get('/api/patients')
      .set('Authorization', `Bearer ${adminToken}`);
    patientId = (patientsRes.body.data ?? patientsRes.body)[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('invoice totals are server-derived', () => {
    it('computes subtotal, tax and total from the line items', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/billing/invoices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          patientId,
          items: [
            { description: 'Root canal', quantity: 2, unitPrice: 100 },
            { description: 'X-ray', quantity: 1, unitPrice: 50 },
          ],
        })
        .expect(201);

      // 2 * 100 + 1 * 50 = 250 subtotal, 8% tax = 20, total = 270
      expect(Number(res.body.subtotal)).toBe(250);
      expect(Number(res.body.tax)).toBe(20);
      expect(Number(res.body.total)).toBe(270);
    });

    it('rejects a client-supplied total instead of honouring it', async () => {
      await request(app.getHttpServer())
        .post('/api/billing/invoices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          patientId,
          subtotal: 1,
          tax: 0,
          total: 1,
          items: [{ description: 'Crown', quantity: 1, unitPrice: 900 }],
        })
        .expect(400);
    });

    it('rejects an invoice with no line items', async () => {
      await request(app.getHttpServer())
        .post('/api/billing/invoices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ patientId, items: [] })
        .expect(400);
    });
  });

  describe('payment recording', () => {
    let invoiceId: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post('/api/billing/invoices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          patientId,
          items: [{ description: 'Cleaning', quantity: 1, unitPrice: 100 }],
        });
      invoiceId = res.body.id;
    });

    it('marks an invoice partial then paid as payments arrive', async () => {
      // Invoice total is 100 + 8% tax = 108
      await request(app.getHttpServer())
        .post(`/api/billing/invoices/${invoiceId}/payments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 50, method: 'cash' })
        .expect(201);

      const partial = await request(app.getHttpServer())
        .get(`/api/billing/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(partial.body.status).toBe('partial');

      await request(app.getHttpServer())
        .post(`/api/billing/invoices/${invoiceId}/payments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 58, method: 'cash' })
        .expect(201);

      const paid = await request(app.getHttpServer())
        .get(`/api/billing/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(paid.body.status).toBe('paid');
    });

    it('rejects a payment that would exceed the invoice total', async () => {
      await request(app.getHttpServer())
        .post(`/api/billing/invoices/${invoiceId}/payments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 500, method: 'cash' })
        .expect(400);
    });

    it('does not let concurrent payments overpay the invoice', async () => {
      // Both requests read the same zero balance before either commits.
      // Without serializable isolation both would be accepted.
      const results = await Promise.allSettled(
        [70, 70].map((amount) =>
          request(app.getHttpServer())
            .post(`/api/billing/invoices/${invoiceId}/payments`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ amount, method: 'cash' })
        )
      );

      const accepted = results.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 201
      );
      expect(accepted.length).toBeLessThanOrEqual(1);

      const final = await request(app.getHttpServer())
        .get(`/api/billing/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      const totalPaid = final.body.payments.reduce(
        (sum: number, p: { amount: string }) => sum + Number(p.amount),
        0
      );
      expect(totalPaid).toBeLessThanOrEqual(Number(final.body.total));
    });
  });
});
