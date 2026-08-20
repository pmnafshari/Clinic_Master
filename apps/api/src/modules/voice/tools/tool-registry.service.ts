import { Injectable } from '@nestjs/common';
import { VoiceTool } from './tool-definition.interface';

@Injectable()
export class ToolRegistryService {
  private readonly tools = new Map<string, VoiceTool>();

  /**
   * Registration is boot-time wiring, so this throws rather than returning a
   * failure: a misconfigured tool set must stop the process, not serve calls.
   *
   * A silent overwrite was a real hole. Names are the only thing binding a
   * model's tool_use to a tier, so registering a 'public' tool under a
   * 'verified' tool's name would quietly downgrade it — every later call to
   * that name would skip the verification gate, with nothing in the logs to
   * say so. There is no legitimate reason to register two tools under one
   * name, so the collision is refused outright.
   */
  register(tool: VoiceTool): void {
    const existing = this.tools.get(tool.name);
    if (existing) {
      throw new Error(
        `Duplicate voice tool name "${tool.name}": ` +
          `${existing.constructor?.name ?? 'a tool'} (tier ${existing.tier}) is already ` +
          `registered under it. Tool names must be unique — a second registration ` +
          `would silently replace the first and could downgrade its tier.`
      );
    }

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
