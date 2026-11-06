import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import {
  ConfigError,
  readDiagnosticConfig,
  resolveDiagnosticSources,
  configFindings,
  type ResolvedSource,
} from './config.js';
import {
  makeReport,
  renderReport,
  type DiagnosticReport,
  type Finding,
} from './report.js';
import {
  inspectInWorker,
  incomplete,
  inspectWithPublishedTool,
  type Inspection,
} from './processes.js';
export const HELP = `tenantguard doctor --config <json> [--connect] [--json] [--fail-on error|warning]
tenantguard audit --config <json> [--json] [--fail-on error|warning]
Doctor validates offline by default. Audit inspects declared database catalogs read-only.
Exits: 0 no errors observed; 1 findings; 2 invalid configuration/arguments; 3 incomplete inspection.
Connection credentials are resolved from explicit environment references, never CLI URL arguments.
`;
async function sourceInspection(
  source: ResolvedSource,
  command: 'doctor' | 'audit',
): Promise<Inspection> {
  try {
    const started = performance.now();
    const native = await inspectInWorker(source, source.timeoutMs);
    if (!native.complete) return native;
    const tool =
      command === 'audit' && ['postgres', 'mysql'].includes(source.engine)
        ? 'tenant-audit'
        : command === 'doctor' &&
            ['postgres', 'mysql', 'mariadb', 'sqlite'].includes(source.engine)
          ? 'db-deploy-doctor'
          : undefined;
    if (!tool)
      return {
        ...native,
        findings: [
          ...native.findings,
          {
            source: source.name,
            code:
              command === 'audit'
                ? 'COVERAGE.RELATIONSHIPS_UNVERIFIED'
                : 'COVERAGE.DEPLOYMENT_UNVERIFIED',
            severity: 'info',
            message:
              command === 'audit'
                ? 'Published tenant-audit 0.2.0 does not implement relationship analysis for this engine.'
                : 'Published db-deploy-doctor 0.2.0 does not implement readiness checks for this engine.',
          },
        ],
      };
    const upstream = await inspectWithPublishedTool(
      source,
      tool,
      source.timeoutMs - (performance.now() - started),
    );
    return {
      complete: upstream.complete,
      findings: [...native.findings, ...upstream.findings],
    };
  } catch {
    return incomplete(source.name);
  }
}
export async function diagnose(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DiagnosticReport | { readonly help: true }> {
  let command: DiagnosticReport['command'] = 'unknown',
    connected = false,
    failOn: 'error' | 'warning' = 'error';
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      tokens: true,
      options: {
        config: { type: 'string' },
        json: { type: 'boolean' },
        connect: { type: 'boolean' },
        'fail-on': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (parsed.values.help) return { help: true };
    if (
      parsed.positionals.length !== 1 ||
      !['doctor', 'audit'].includes(parsed.positionals[0]!)
    )
      throw new ConfigError('CLI.ARGUMENTS', 'arguments');
    command = parsed.positionals[0] as 'doctor' | 'audit';
    if (
      !parsed.values.config ||
      parsed.tokens.filter(
        (token) => token.kind === 'option' && token.name === 'config',
      ).length !== 1 ||
      (command === 'audit' && parsed.values.connect)
    )
      throw new ConfigError('CLI.ARGUMENTS', 'arguments');
    if (
      parsed.values['fail-on'] !== undefined &&
      !['error', 'warning'].includes(parsed.values['fail-on'])
    )
      throw new ConfigError('CLI.ARGUMENTS', 'arguments');
    failOn = (parsed.values['fail-on'] ?? 'error') as typeof failOn;
    const config = await readDiagnosticConfig(resolve(parsed.values.config));
    const sources = resolveDiagnosticSources(
      config,
      { ...environment },
      dirname(resolve(parsed.values.config)),
    );
    const findings: Finding[] = configFindings(sources);
    const scope = sources.map((source) => ({
      source: source.name,
      engine: source.engine,
      mode: source.mode,
      targets: source.targets.map(
        (target) => (target.schema ? target.schema + '.' : '') + target.table,
      ),
    }));
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major! < 22 || (major === 22 && minor! < 16))
      throw new ConfigError('RUNTIME.NODE_VERSION', 'runtime');
    connected = command === 'audit' || parsed.values.connect === true;
    if (!connected)
      return makeReport(command, false, findings, { failOn, scope });
    const results: Inspection[] = new Array(sources.length);
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(config.concurrency, sources.length) },
        async () => {
          for (;;) {
            const index = next++;
            if (index >= sources.length) return;
            results[index] = await sourceInspection(
              sources[index]!,
              command as 'doctor' | 'audit',
            );
          }
        },
      ),
    );
    return makeReport(
      command,
      true,
      [...findings, ...results.flatMap((result) => result.findings)],
      { incomplete: results.some((result) => !result.complete), failOn, scope },
    );
  } catch (error) {
    const value =
      error instanceof ConfigError
        ? error
        : new ConfigError('CLI.ARGUMENTS', 'arguments');
    return makeReport(
      command,
      connected,
      [
        {
          code: value.code,
          severity: 'error',
          message: `Configuration rejected at ${value.field}.`,
        },
      ],
      { invalid: true, failOn },
    );
  }
}
export async function main(
  args: readonly string[] = process.argv.slice(2),
  io: { write: (text: string) => void } = {
    write: (text) => process.stdout.write(text),
  },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const result = await diagnose(args, environment);
  if ('help' in result) {
    io.write(HELP);
    return 0;
  }
  io.write(renderReport(result, args.includes('--json')));
  return result.exitCode;
}
