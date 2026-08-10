import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

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

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let messages: string[] = ['Internal server error'];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        messages = [res];
      } else if (Array.isArray((res as any).message)) {
        messages = (res as any).message.map((msg: string) =>
          this.humanizeMessage(msg)
        );
      } else {
        messages = [(res as any).message || exception.message];
      }
    } else if (exception instanceof Error) {
      messages = [exception.message];
      this.logger.error(
        `Unhandled error: ${exception.message}`,
        exception.stack,
      );
    }

    const errorResponse: ErrorResponse = {
      statusCode: status,
      message: messages[0] || 'Internal server error',
      messages,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(status).json(errorResponse);
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
