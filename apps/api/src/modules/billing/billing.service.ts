import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { handlePrismaError } from '../../common/utils/prisma-error.util';

/**
 * Sales tax applied to invoice subtotals. Lives on the server so the rate
 * cannot be influenced by the client.
 */
const TAX_RATE = new Prisma.Decimal(process.env.INVOICE_TAX_RATE ?? '0.08');

@Injectable()
export class BillingService {
  constructor(private prisma: PrismaService) {}

  /**
   * Invoice numbers are random rather than sequential so they cannot be
   * enumerated, and so concurrent creates cannot collide on a timestamp.
   */
  private generateInvoiceNumber(): string {
    return `INV-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  async findAllInvoices(patientId?: string, status?: string) {
    const where: any = {};

    if (patientId) {
      where.patientId = patientId;
    }

    if (status) {
      where.status = status;
    }

    try {
      return await this.prisma.invoice.findMany({
        where,
        include: {
          patient: true,
          items: true,
          payments: true,
          treatmentPlan: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async findInvoiceById(id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        patient: true,
        items: true,
        payments: true,
        treatmentPlan: true,
        appointment: true,
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    return invoice;
  }

  async createInvoice(createInvoiceDto: CreateInvoiceDto) {
    const { items, patientId, treatmentPlanId, appointmentId } = createInvoiceDto;

    if (!items || items.length === 0) {
      throw new BadRequestException('An invoice must contain at least one line item');
    }

    // Totals are derived from the line items, never taken from the request —
    // a client-supplied total would let a caller set its own price.
    const pricedItems = items.map((item) => {
      const quantity = item.quantity ?? 1;
      const unitPrice = new Prisma.Decimal(item.unitPrice);
      return {
        description: item.description,
        procedureCode: item.procedureCode,
        quantity,
        unitPrice,
        total: unitPrice.mul(quantity),
      };
    });

    const subtotal = pricedItems.reduce(
      (sum, item) => sum.add(item.total),
      new Prisma.Decimal(0)
    );
    const tax = subtotal.mul(TAX_RATE).toDecimalPlaces(2);
    const total = subtotal.add(tax);

    try {
      // The invoice and its items are written together: a failure partway
      // through must not leave an invoice with no line items.
      const invoice = await this.prisma.$transaction(async (tx) => {
        const created = await tx.invoice.create({
          data: {
            patientId,
            treatmentPlanId,
            appointmentId,
            invoiceNumber: this.generateInvoiceNumber(),
            subtotal,
            tax,
            total,
            status: 'unpaid',
            issuedAt: new Date(),
            dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          },
        });

        await tx.invoiceItem.createMany({
          data: pricedItems.map((item) => ({ ...item, invoiceId: created.id })),
        });

        return created;
      });

      return this.findInvoiceById(invoice.id);
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async recordPayment(invoiceId: string, createPaymentDto: CreatePaymentDto) {
    const amount = new Prisma.Decimal(createPaymentDto.amount);

    try {
      // Serializable isolation closes the read-then-write window: without it,
      // two concurrent payments can both read the same outstanding balance,
      // both pass the overpayment check, and both commit. The payment insert
      // and the resulting status change also have to land together.
      return await this.prisma.$transaction(
        async (tx) => {
          const invoice = await tx.invoice.findUnique({
            where: { id: invoiceId },
            include: { payments: true },
          });

          if (!invoice) {
            throw new NotFoundException('Invoice not found');
          }

          if (invoice.status === 'paid') {
            throw new BadRequestException('Invoice is already fully paid');
          }

          const alreadyPaid = invoice.payments.reduce(
            (sum, p) => sum.add(p.amount),
            new Prisma.Decimal(0)
          );
          const newTotalPaid = alreadyPaid.add(amount);

          if (newTotalPaid.greaterThan(invoice.total)) {
            throw new BadRequestException('Payment amount exceeds invoice total');
          }

          const payment = await tx.payment.create({
            data: {
              invoiceId,
              amount,
              method: createPaymentDto.method,
              reference: createPaymentDto.reference,
              notes: createPaymentDto.notes,
              paidAt: new Date(),
            },
          });

          await tx.invoice.update({
            where: { id: invoiceId },
            data: {
              status: newTotalPaid.greaterThanOrEqualTo(invoice.total) ? 'paid' : 'partial',
            },
          });

          return payment;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      handlePrismaError(error);
    }
  }

  async getPatientBalance(patientId: string) {
    try {
      const invoices = await this.prisma.invoice.findMany({
        where: { patientId },
        include: { payments: true },
      });

      // Decimal arithmetic throughout — summing currency as JS floats
      // accumulates rounding error across a patient's invoice history.
      const totalBilled = invoices.reduce(
        (sum, inv) => sum.add(inv.total),
        new Prisma.Decimal(0)
      );
      const totalPaid = invoices.reduce(
        (sum, inv) =>
          sum.add(inv.payments.reduce((pSum, p) => pSum.add(p.amount), new Prisma.Decimal(0))),
        new Prisma.Decimal(0)
      );

      return {
        totalBilled: totalBilled.toFixed(2),
        totalPaid: totalPaid.toFixed(2),
        balance: totalBilled.sub(totalPaid).toFixed(2),
      };
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async findAllPayments(invoiceId?: string) {
    const where = invoiceId ? { invoiceId } : {};

    try {
      return await this.prisma.payment.findMany({
        where,
        include: {
          invoice: true,
        },
        orderBy: { paidAt: 'desc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }
}
