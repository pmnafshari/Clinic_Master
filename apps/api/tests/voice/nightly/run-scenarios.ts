import { ClaudeAgentService, AnthropicLike } from '../../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../../src/modules/voice/tools/tool-executor.service';
import { ClinicInfoTool } from '../../../src/modules/voice/tools/clinic-info.tool';
import { ServicePricingTool } from '../../../src/modules/voice/tools/service-pricing.tool';
import { CheckAvailabilityTool } from '../../../src/modules/voice/tools/check-availability.tool';
import { createAnonymousSession } from '../../../src/modules/voice/session/voice-session';
import { UsageTrackingClient } from './usage-tracking-client';
import {
  NightlyScenario,
  NIGHTLY_SCENARIOS,
  NIGHTLY_TOKEN_BUDGET,
  isGenuineRefusal,
  validateScenarios,
} from './scenarios';

export interface NightlyRunResult {
  failures: string[];
  totalTokens: number;
  scenariosRun: number;
  scenariosPlanned: number;
}

/**
 * Real tools, mocked external services, no database. This job runs from a
 * schedule with Docker/Postgres unavailable, so nothing here may reach
 * AppointmentsService's or UsersService's real Prisma-backed implementation.
 */
function buildToolWiring(): { registry: ToolRegistryService; executor: ToolExecutorService } {
  const registry = new ToolRegistryService();
  const executor = new ToolExecutorService(registry);

  const appointments = {
    getAvailability: async () => [{ time: '09:00', available: true }],
  };
  const users = { findProviders: async () => [{ id: 'prov-1' }] };

  registry.register(new ClinicInfoTool());
  registry.register(new ServicePricingTool());
  registry.register(new CheckAvailabilityTool(appointments as never, users as never));

  return { registry, executor };
}

/**
 * The harness logic, factored out of the CLI entrypoint (agent-behaviour.nightly.ts)
 * so it can be exercised offline in the normal Jest suite with a fake
 * `client` — no network call, no API key, no spend. The entrypoint is the
 * only place a real Anthropic client is constructed and passed in here.
 *
 * The budget is enforced *during* the run, checked after every scenario's
 * turn against the real accumulated `response.usage`, and the loop stops
 * the moment it is crossed — a run that goes over budget does not go on to
 * finish the scenario list first.
 */
export async function runNightlyScenarios(
  client: AnthropicLike,
  scenarios: NightlyScenario[] = NIGHTLY_SCENARIOS,
  budget: number = NIGHTLY_TOKEN_BUDGET
): Promise<NightlyRunResult> {
  validateScenarios(scenarios);

  const { registry, executor } = buildToolWiring();
  const tracker = new UsageTrackingClient(client);
  const agent = new ClaudeAgentService(registry, executor, tracker);
  const failures: string[] = [];
  let scenariosRun = 0;

  for (const scenario of scenarios) {
    const session = createAnonymousSession(`nightly-${scenario.name}`);
    const turn = await agent.respond(session, scenario.message, []);
    scenariosRun += 1;

    if (scenario.expectToolCall && !turn.toolCalls.includes(scenario.expectToolCall)) {
      failures.push(
        `${scenario.name}: expected tool "${scenario.expectToolCall}", got [${turn.toolCalls.join(', ')}]`
      );
    }

    if (scenario.expectNoToolCall && turn.toolCalls.length > 0) {
      failures.push(`${scenario.name}: expected no tool call, got [${turn.toolCalls.join(', ')}]`);
    }

    if (scenario.expectReplyMatches && !scenario.expectReplyMatches.test(turn.reply)) {
      failures.push(`${scenario.name}: reply did not match expected pattern — "${turn.reply}"`);
    }

    if (scenario.expectRefusal && !isGenuineRefusal(turn.reply)) {
      failures.push(
        `${scenario.name}: reply does not read as a genuine refusal — "${turn.reply}"`
      );
    }

    // Checked after every turn, not once at the end of the loop: a run that
    // is already over budget must stop spending immediately, not finish the
    // remaining scenarios first.
    if (tracker.usage.totalTokens > budget) {
      failures.push(
        `token budget exceeded after "${scenario.name}": used ${tracker.usage.totalTokens}, ` +
          `budget is ${budget}`
      );
      break;
    }
  }

  return {
    failures,
    totalTokens: tracker.usage.totalTokens,
    scenariosRun,
    scenariosPlanned: scenarios.length,
  };
}
