import { Injectable } from '@nestjs/common';
import { VoiceTool } from './tool-definition.interface';

@Injectable()
export class ToolRegistryService {
  private readonly tools = new Map<string, VoiceTool>();

  register(tool: VoiceTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): VoiceTool | undefined {
    return this.tools.get(name);
  }

  all(): VoiceTool[] {
    return [...this.tools.values()];
  }

  verifiedTools(): VoiceTool[] {
    return this.all().filter((tool) => tool.tier === 'verified');
  }
}
