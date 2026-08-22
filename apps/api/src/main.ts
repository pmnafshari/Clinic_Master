import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { WsAdapter } from '@nestjs/platform-ws';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

function assertSecureConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const jwtSecret = process.env.JWT_SECRET || '';

  if (nodeEnv === 'production') {
    if (!jwtSecret || jwtSecret.length < 32) {
      throw new Error(
        'JWT_SECRET must be set to a strong secret (at least 32 characters) when NODE_ENV=production'
      );
    }
  }
}

async function bootstrap() {
  assertSecureConfig();

  const app = await NestFactory.create(AppModule);

  // Raw `ws` rather than Socket.IO: it exposes the HTTP upgrade, which is what
  // lets an origin check reject a handshake before it becomes a WebSocket.
  // The origin-checking subclass replaces this adapter when those controls land.
  app.useWebSocketAdapter(new WsAdapter(app));

  app.use(helmet());
  app.useGlobalFilters(new AllExceptionsFilter());

  app.setGlobalPrefix('api');

  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })
  );

  const isProduction = (process.env.NODE_ENV || 'development') === 'production';

  if (!isProduction) {
    const config = new DocumentBuilder()
      .setTitle('SmileFlow API')
      .setDescription('Dental Clinic Management Platform API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 3001;
  await app.listen(port);
  Logger.log(`Application is running on: http://localhost:${port}`, 'Bootstrap');
  if (!isProduction) {
    Logger.log(`Swagger documentation: http://localhost:${port}/api/docs`, 'Bootstrap');
  }
}
bootstrap();
