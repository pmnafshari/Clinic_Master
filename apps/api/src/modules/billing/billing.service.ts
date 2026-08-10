import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { handlePrismaError } from '../../common/utils/prisma-error.util';

@Injectable()
export class BillingService {
  constructor(private prisma: PrismaService) {}

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
    const invoiceNumber = `INV-${Date.now()}`;

    const { items, ...invoiceData } = createInvoiceDto;

    try {
      const invoice = await this.prisma.invoice.create({
        data: {
          patientId: invoiceData.patientId,
          treatmentPlanId: invoiceData.treatmentPlanId,
          appointmentId: invoiceData.appointmentId,
          invoiceNumber,
          subtotal: invoiceData.subtotal,
          tax: invoiceData.tax || 0,
          total: invoiceData.total,
          status: 'unpaid',
          issuedAt: new Date(),
          dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        },
      });

      if (items && items.length > 0) {
        await this.prisma.invoiceItem.createMany({
          data: items.map((item) => ({
            invoiceId: invoice.id,
            description: item.description,
            procedureCode: item.procedureCode,
            quantity: item.quantity || 1,
            unitPrice: item.unitPrice,
            total: item.total,
          })),
        });
      }

      return this.findInvoiceById(invoice.id);
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async recordPayment(invoiceId: string, createPaymentDto: CreatePaymentDto) {
    const invoice = await this.findInvoiceById(invoiceId);

    if (invoice.status === 'paid') {
      throw new BadRequestException('Invoice is already fully paid');
    }

    const totalPaid = invoice.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const newTotalPaid = totalPaid + createPaymentDto.amount;

    if (newTotalPaid > Number(invoice.total)) {
      throw new BadRequestException('Payment amount exceeds invoice total');
    }

    try {
      const payment = await this.prisma.payment.create({
        data: {
          invoiceId,
          amount: createPaymentDto.amount,
          method: createPaymentDto.method,
          reference: createPaymentDto.reference,
          notes: createPaymentDto.notes,
          paidAt: new Date(),
        },
      });

      const newStatus = newTotalPaid >= Number(invoice.total) ? 'paid' : 'partial';

      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: newStatus },
      });

      return payment;
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async getPatientBalance(patientId: string) {
    try {
      const invoices = await this.prisma.invoice.findMany({
        where: { patientId },
        include: { payments: true },
      });

      const totalBilled = invoices.reduce((sum, inv) => sum + Number(inv.total), 0);
      const totalPaid = invoices.reduce(
        (sum, inv) => sum + inv.payments.reduce((pSum, p) => pSum + Number(p.amount), 0),
        0
      );

      return {
        totalBilled,
        totalPaid,
        balance: totalBilled - totalPaid,
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
