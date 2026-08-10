import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ReportingService {
  constructor(private prisma: PrismaService) {}

  async getDashboardKPIs(startDate?: string, endDate?: string) {
    const now = new Date();
    const rangeStart = startDate
      ? new Date(startDate)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const rangeEnd = endDate
      ? new Date(endDate)
      : new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const [
      totalPatients,
      newPatients,
      appointments,
      revenue,
      pendingInvoices,
      completedAppointments,
      noShowAppointments,
    ] = await Promise.all([
      this.prisma.patient.count(),
      this.prisma.patient.count({
        where: {
          createdAt: { gte: rangeStart, lte: rangeEnd },
        },
      }),
      this.prisma.appointment.count({
        where: {
          startTime: { gte: rangeStart, lte: rangeEnd },
        },
      }),
      this.prisma.payment.aggregate({
        where: {
          paidAt: { gte: rangeStart, lte: rangeEnd },
        },
        _sum: { amount: true },
      }),
      this.prisma.invoice.count({
        where: { status: 'unpaid' },
      }),
      this.prisma.appointment.count({
        where: {
          status: 'completed',
          startTime: { gte: rangeStart, lte: rangeEnd },
        },
      }),
      this.prisma.appointment.count({
        where: {
          status: 'no-show',
          startTime: { gte: rangeStart, lte: rangeEnd },
        },
      }),
    ]);

    return {
      totalPatients,
      newPatients,
      appointments,
      revenue: revenue._sum.amount || 0,
      pendingInvoices,
      completedAppointments,
      noShowAppointments,
      noShowRate:
        appointments > 0 ? (noShowAppointments / appointments) * 100 : 0,
    };
  }

  async getRevenueSummary(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    const payments = await this.prisma.payment.groupBy({
      by: ['method'],
      where: {
        paidAt: { gte: start, lte: end },
      },
      _sum: { amount: true },
      _count: true,
    });

    const totalRevenue = await this.prisma.payment.aggregate({
      where: {
        paidAt: { gte: start, lte: end },
      },
      _sum: { amount: true },
    });

    return {
      totalRevenue: totalRevenue._sum.amount || 0,
      byPaymentMethod: payments.map((p) => ({
        method: p.method,
        total: p._sum.amount,
        count: p._count,
      })),
    };
  }

  async getAppointmentStats(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    const stats = await this.prisma.appointment.groupBy({
      by: ['status'],
      where: {
        startTime: { gte: start, lte: end },
      },
      _count: true,
    });

    const total = stats.reduce((sum, s) => sum + s._count, 0);

    return {
      total,
      byStatus: stats.map((s) => ({
        status: s.status,
        count: s._count,
        percentage: total > 0 ? (s._count / total) * 100 : 0,
      })),
    };
  }

  async getPatientStats(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    const [total, newPatients] = await Promise.all([
      this.prisma.patient.count(),
      this.prisma.patient.count({
        where: {
          createdAt: { gte: start, lte: end },
        },
      }),
    ]);

    const newPatientsByMonth = await this.prisma.patient.groupBy({
      by: ['createdAt'],
      where: {
        createdAt: { gte: start, lte: end },
      },
      _count: true,
    });

    const monthCounts = new Map<string, number>();
    for (const { createdAt, _count } of newPatientsByMonth) {
      const key = createdAt.toISOString().slice(0, 7);
      monthCounts.set(key, (monthCounts.get(key) || 0) + _count);
    }

    const byMonth: Array<{ month: string; label: string; count: number }> = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 7);
      byMonth.push({
        month: key,
        label: cursor.toLocaleString('default', { month: 'short', year: '2-digit' }),
        count: monthCounts.get(key) || 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return { total, newPatients, byMonth };
  }

  async getTreatmentAcceptance(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    const plans = await this.prisma.treatmentPlan.groupBy({
      by: ['status'],
      where: {
        createdAt: { gte: start, lte: end },
      },
      _count: true,
    });

    const total = plans.reduce((sum, p) => sum + p._count, 0);
    const approved = plans.find((p) => p.status === 'approved')?._count || 0;

    return {
      total,
      accepted: approved,
      acceptanceRate: total > 0 ? (approved / total) * 100 : 0,
      byStatus: plans.map((p) => ({
        status: p.status,
        count: p._count,
      })),
    };
  }
}
