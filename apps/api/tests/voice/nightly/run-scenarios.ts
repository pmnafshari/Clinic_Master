import { ClaudeAgentService, AnthropicLike } from '../../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../../src/modules/voice/tools/tool-executor.service';
import { ClinicInfoTool } from '../../../src/modules/voice/tools/clinic-info.tool';
import { ServicePricingTool } from '../../../src/modules/voice/tools/service-pricing.tool';
import { CheckAvailabilityTool } from '../../../src/modules/voice/tools/check-availability.tool';
import { createAnonymousSession } from '../../../src/modules/voice/session/voice-session';
import { BudgetExceededError, UsageTrackingClient } from './usage-tracking-client';
import { JudgeVerdict, judgeClinicalReply } from './clinical-judge';
import {
  NightlyScenario,
  NIGHTLY_SCENARIOS,
  NIGHTLY_TOKEN_BUDGET,
  isGenuineRefusal,
  validateScenarios,
} from './scenarios';

export interface RefusalTranscript {
  name: string;
  reply: string;
  /**
   * The LLM judge's verdict on this reply — the actual pass/fail gate for
   * `expectRefusal` scenarios. See clinical-judge.ts.
   */
  judge: JudgeVerdict;
  /**
   * isGenuineRefusal's verdict on the same reply, kept only as a cheap
   * advisory signal printed alongside the judge's verdict and the
   * transcript. It is NOT the gate — see scenarios.ts for why the regex
   * approach was retired as a pass/fail mechanism.
   */
  advisoryRegexSignal: boolean;
}

export interface NightlyRunResult {
  failures: string[];
  totalTokens: number;
  scenariosRun: number;
  scenariosPlanned: number;
  /**
   * The verbatim reply for every scenario that declares `expectRefusal`,
   * captured whether that scenario passed or failed. No regex is a
   * complete advice detector, so the printed transcript — not the boolean
   * — is the real check a human reviewing the nightly output relies on.
   */
  refusalTranscripts: RefusalTranscript[];
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
 * The budget is enforced twice. Primarily inside UsageTrackingClient, which
 * throws BudgetExceededError the instant a single API call's usage pushes
 * the running total over budget — this fires mid-scenario, before a
 * runaway tool loop can make its remaining calls (up to
 * MAX_TOOL_ITERATIONS). Secondarily as a backstop check after each
 * scenario's turn completes normally, kept in case the per-call enforcement
 * is ever bypassed. The same `tracker` also wraps every call the LLM judge
 * makes (see the `expectRefusal` branch below), so a judge call counts
 * against this exact budget too — it is not a separate, unaccounted spend
 * path.
 */
export async function runNightlyScenarios(
  client: AnthropicLike,
  scenarios: NightlyScenario[] = NIGHTLY_SCENARIOS,
  budget: number = NIGHTLY_TOKEN_BUDGET
): Promise<NightlyRunResult> {
  validateScenarios(scenarios);

  const { registry, executor } = buildToolWiring();
  const tracker = new UsageTrackingClient(client, budget);
  const agent = new ClaudeAgentService(registry, executor, tracker);
  const failures: string[] = [];
  const refusalTranscripts: RefusalTranscript[] = [];
  let scenariosRun = 0;

  for (const scenario of scenarios) {
    const session = createAnonymousSession(`nightly-${scenario.name}`);

    let turn;
    try {
      turn = await agent.respond(session, scenario.message, []);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        failures.push(
          `token budget exceeded during "${scenario.name}": used ${error.totalTokens}, ` +
            `budget is ${error.budget}`
        );
        break;
      }
      throw error;
    }

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

    if (scenario.expectRefusal) {
      // isGenuineRefusal is kept only as a cheap, offline advisory signal —
      // printed alongside the transcript below, never used to decide
      // pass/fail. See scenarios.ts for why the regex approach was retired
      // as a gate.
      const advisoryRegexSignal = isGenuineRefusal(turn.reply);

      // The actual gate: an LLM judge classifying the (userRequest,
      // agentReply) pair. `tracker` is the same UsageTrackingClient wrapping
      // the agent's own calls, so this call is priced against and enforced
      // by the identical token budget (see the class doc on
      // UsageTrackingClient and the doc on judgeClinicalReply).
      let judge: JudgeVerdict;
      try {
        judge = await judgeClinicalReply(tracker, {
          userRequest: scenario.message,
          agentReply: turn.reply,
        });
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          failures.push(
            `token budget exceeded while judging "${scenario.name}": used ` +
              `${error.totalTokens}, budget is ${error.budget}`
          );
          break;
        }
        throw error;
      }

      // Printed on every run, pass or fail — see NightlyRunResult.refusalTranscripts.
      refusalTranscripts.push({ name: scenario.name, reply: turn.reply, judge, advisoryRegexSignal });

      // FAIL CLOSED: judge.passed is false for every non-`no_advice`
      // outcome — an actual advice classification, a judge error, an
      // unparseable/schema-invalid response, or a low-confidence call all
      // fail the scenario. An uncertain or broken judge is never treated as
      // a safe reply.
      if (!judge.passed) {
        failures.push(
          `${scenario.name}: LLM judge did not confirm a refusal (${judge.outcome}) — ` +
            `${judge.detail}`
        );
      }
    }

    // Backstop: re-check after the scenario completes. In the normal case
    // UsageTrackingClient will already have thrown before this is reached
    // for any call that crosses budget; this only fires if that per-call
    // enforcement is ever bypassed.
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
    refusalTranscripts,
  };
}
