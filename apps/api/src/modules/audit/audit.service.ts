import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /**
   * `userId` is optional because a voice tool call has to be auditable before
   * the caller has been identified — an anonymous session has no user.
   *
   * `sessionLogId` carries `VoiceSession.logId`, the non-secret per-conversation
   * correlation id, and correlates every tool call made in one conversation.
   * It is never the sessionId: that is a bearer credential, and persisting it
   * would leave live credentials at rest in a table any DB read, backup, or ops
   * query can reach.
   */
  async log(data: {
    userId?: string | null;
    sessionLogId?: string | null;
    entityType: string;
    entityId?: string;
    action: string;
    oldValues?: any;
    newValues?: any;
    ipAddress?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        userId: data.userId ?? null,
        sessionLogId: data.sessionLogId ?? null,
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
