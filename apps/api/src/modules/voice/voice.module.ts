import { Module } from '@nestjs/common';
import { ToolRegistryService } from './tools/tool-registry.service';
import { ToolExecutorService } from './tools/tool-executor.service';

@Module({
  controllers: [],
  providers: [ToolRegistryService, ToolExecutorService],
  exports: [ToolRegistryService, ToolExecutorService],
})
export class VoiceModule {}
