import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * The only thing an unexpected failure ever tells a client.
 *
 * Deliberately says nothing: which layer failed, which host was unreachable,
 * which constraint fired and which provider rejected a credential are all
 * things an attacker would like to know and a legitimate caller cannot act on.
 */
const GENERIC_MESSAGE = 'Internal server error';

interface ErrorResponse {
  statusCode: number;
  message: string;
  messages: string[];
  timestamp: string;
  path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, messages } = this.publicError(exception, request);

    const errorResponse: ErrorResponse = {
      statusCode: status,
      message: messages[0] || GENERIC_MESSAGE,
      messages,
      timestamp: new Date().toISOString(),
      // Path only. A query string can carry a token or a one-time ticket, and
      // echoing the request back would put it in the client's error log and in
      // any report the client forwards on.
      path: request.url?.split('?')[0] ?? '',
    };

    response.status(status).json(errorResponse);
  }

  /**
   * Decides what the client is allowed to know.
   *
   * An HttpException was raised deliberately by this application: its status
   * and its message are the intended contract, and a 404 that says "Patient
   * not found" is useful rather than dangerous.
   *
   * Everything else arrived by accident — a database that is unreachable, a
   * provider that rejected a key, a bug. Those messages name hosts, ports,
   * columns, projects and internal state, so none of them travels. The real
   * error is logged here instead, where only an operator can read it.
   */
  private publicError(
    exception: unknown,
    request: Request
  ): { status: number; messages: string[] } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        return { status, messages: [res] };
      }

      const body = res as { message?: unknown };
      if (Array.isArray(body.message)) {
        return {
          status,
          messages: body.message.map((msg: string) => this.humanizeMessage(msg)),
        };
      }

      if (typeof body.message === 'string') {
        return { status, messages: [body.message] };
      }

      // An HttpException whose body carries no message. Falling back to
      // exception.message would reach for whatever a wrapping layer put there,
      // which is exactly the text this filter exists to withhold.
      return { status, messages: [GENERIC_MESSAGE] };
    }

    this.logInternal(exception, request);
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, messages: [GENERIC_MESSAGE] };
  }

  /** The detail stays here. Nothing written in this method leaves the server. */
  private logInternal(exception: unknown, request: Request): void {
    const where = `${request.method ?? 'REQUEST'} ${request.url?.split('?')[0] ?? ''}`;

    if (exception instanceof Error) {
      this.logger.error(`Unhandled error on ${where}: ${exception.name}: ${exception.message}`, exception.stack);
      return;
    }

    this.logger.error(`Unhandled non-error thrown on ${where}: ${String(exception)}`);
  }

  private humanizeMessage(message: string): string {
    if (message.includes(' should not exist')) {
      const nestedDotProp = message.match(/^([\w]+)\.property\s+(\w+)\s+should not exist$/);
      if (nestedDotProp) {
        return `Invalid field "${nestedDotProp[2]}" in ${nestedDotProp[1]}`;
      }

      const flatMatch = message.match(/^Property\s+([\w.]+)\s+should not exist$/);
      if (flatMatch) {
        const fieldName = flatMatch[1].split('.').pop() || flatMatch[1];
        const humanized = fieldName
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (s: string) => s.toUpperCase())
          .trim();
        return `${humanized} is not a valid field`;
      }

      const simpleMatch = message.match(/^([\w.]+)\s+should not exist$/);
      if (simpleMatch) {
        const fieldName = simpleMatch[1].split('.').pop() || simpleMatch[1];
        const humanized = fieldName
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (s: string) => s.toUpperCase())
          .trim();
        return `${humanized} is not a valid field`;
      }
    }

    return message
      .replace(/^([a-zA-Z]+)\s/, (_, field) => {
        const humanized = field
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (s: string) => s.toUpperCase())
          .trim();
        return `${humanized} `;
      })
      .replace(/\.$/, '');
  }
}
