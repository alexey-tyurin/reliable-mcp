import { assertChaosAllowed } from './guard.js';
import { ChaosController } from './controller.js';
import type { FaultTarget, FaultConfig } from './fault-types.js';

const VALID_TARGETS: readonly FaultTarget[] = [
  'weather-api', 'flight-api', 'weather-mcp', 'flight-mcp',
  'redis', 'redis-cache', 'redis-session', 'oauth-token', 'llm-api',
];

const VALID_FAULT_TYPES = [
  'latency', 'error', 'timeout', 'malformed',
  'connection-refused', 'connection-drop', 'rate-limit', 'schema-mismatch',
] as const;

function parseArgs(args: string[]): { command: string; positional: string[]; flags: Map<string, string> } {
  const command = args[0] ?? '';
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 1; i < args.length; i++) {
    const arg = args.at(i);
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args.at(i + 1);
      if (value !== undefined && !value.startsWith('--')) {
        flags.set(key, value);
        i++;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function buildFaultConfig(faultType: string, flags: Map<string, string>): FaultConfig {
  const statusCode = Number(flags.get('status') ?? '503');
  const delayMs = Number(flags.get('delay') ?? '1000');

  switch (faultType) {
    case 'latency':
      return { type: 'latency', delayMs };
    case 'error':
      return { type: 'error', statusCode };
    case 'timeout':
      return { type: 'timeout', hangMs: delayMs };
    case 'malformed':
      return { type: 'malformed', corruptResponse: true };
    case 'connection-refused':
      return { type: 'connection-refused' };
    case 'connection-drop':
      return { type: 'connection-drop' };
    case 'rate-limit':
      return { type: 'rate-limit', retryAfterSeconds: Number(flags.get('retry-after') ?? '60') };
    case 'schema-mismatch':
      return { type: 'schema-mismatch', missingFields: (flags.get('fields') ?? '').split(',') };
    default:
      throw new Error(`Unknown fault type: ${faultType}`);
  }
}

function printUsage(): void {
  const output = [
    'Usage:',
    '  chaos inject <target> <type> [--status N] [--delay N] [--duration N]',
    '  chaos clear <faultId>',
    '  chaos clear-all',
    '  chaos status',
    '',
    `Targets: ${VALID_TARGETS.join(', ')}`,
    `Fault types: ${VALID_FAULT_TYPES.join(', ')}`,
  ];
  for (const line of output) {
    process.stdout.write(line + '\n');
  }
}

export function runCli(argv: string[]): void {
  assertChaosAllowed();

  const { command, positional, flags } = parseArgs(argv);

  switch (command) {
    case 'inject': {
      const target = positional[0] as FaultTarget | undefined;
      const faultType = positional[1];

      if (!target || !faultType) {
        printUsage();
        return;
      }
      if (!VALID_TARGETS.includes(target)) {
        process.stdout.write(`Invalid target: ${target}\n`);
        return;
      }
      if (!VALID_FAULT_TYPES.includes(faultType as typeof VALID_FAULT_TYPES[number])) {
        process.stdout.write(`Invalid fault type: ${faultType}\n`);
        return;
      }

      const config = buildFaultConfig(faultType, flags);
      const durationStr = flags.get('duration');
      const durationMs = durationStr ? Number(durationStr) * 1000 : undefined;

      const controller = ChaosController.getInstance();
      const faultId = controller.inject(target, config, durationMs);
      process.stdout.write(`Injected fault: ${faultId}\n`);
      break;
    }
    case 'clear': {
      const faultId = positional[0];
      if (!faultId) {
        process.stdout.write('Usage: chaos clear <faultId>\n');
        return;
      }
      const controller = ChaosController.getInstance();
      controller.clear(faultId);
      process.stdout.write(`Cleared fault: ${faultId}\n`);
      break;
    }
    case 'clear-all': {
      const controller = ChaosController.getInstance();
      controller.clearAll();
      process.stdout.write('All faults cleared\n');
      break;
    }
    case 'status': {
      const controller = ChaosController.getInstance();
      const faults = controller.getActiveFaults();
      if (faults.length === 0) {
        process.stdout.write('No active faults\n');
      } else {
        process.stdout.write(`Active faults (${String(faults.length)}):\n`);
        for (const f of faults) {
          process.stdout.write(`  ${f.id} → ${f.target} [${f.type}] (${String(f.requestCount)} requests)\n`);
        }
      }
      break;
    }
    default:
      printUsage();
  }
}

// Direct execution
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
  runCli(cliArgs);
}
