import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(data: {
    userId: string;
    entityType: string;
    entityId?: string;
    action: string;
    oldValues?: any;
    newValues?: any;
    ipAddress?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        userId: data.userId,
        entityType: data.entityType,
        entityId: data.entityId || 'unknown',
        action: data.action,
        oldValues: data.oldValues || undefined,
        newValues: data.newValues || undefined,
        ipAddress: data.ipAddress,
      },
    });
  }

  async findAll(filters?: { entityType?: string; entityId?: string; userId?: string }) {
    const where: any = {};

    if (filters?.entityType) {
      where.entityType = filters.entityType;
    }

    if (filters?.entityId) {
      where.entityId = filters.entityId;
    }

    if (filters?.userId) {
      where.userId = filters.userId;
    }

    return this.prisma.auditLog.findMany({
      where,
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findById(id: string) {
    return this.prisma.auditLog.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });
  }
}
