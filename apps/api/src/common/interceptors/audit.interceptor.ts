import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import { AuditService } from '../../modules/audit/audit.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<Request>();

    const isMutating = ['POST', 'PATCH', 'DELETE'].includes(req.method);
    if (!isMutating) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        this.logMutation(req).catch(() => {
          // Audit logging must never break the request flow.
        });
      })
    );
  }

  private async logMutation(req: Request) {
    const user = (req as any).user;
    if (!user) {
      return;
    }

    const segments = req.path.split('/').filter(Boolean);
    const entityType = segments[1] || 'unknown';
    const entityId =
      (req.params as Record<string, string>)?.id ||
      (req.params as Record<string, string>)?.entryId ||
      (req.params as Record<string, string>)?.patientId ||
      (req.params as Record<string, string>)?.invoiceId ||
      null;

    await this.auditService.log({
      userId: user.id,
      entityType,
      entityId: entityId || undefined,
      action: req.method,
      ipAddress: req.ip,
    });
  }
}
