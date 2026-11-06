import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import type { Finding } from './report.js';
import type { ResolvedSource } from './config.js';
const children = new Set<ChildProcess>();
let stopping = false;
function own<Process extends ChildProcess>(child: Process): Process {
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}
export function stopDiagnosticChildren(): void {
  stopping = true;
  for (const child of children) child.kill('SIGKILL');
}
export interface Inspection {
  readonly findings: Finding[];
  readonly complete: boolean;
}
export const incomplete = (
  source: string,
  code = 'INSPECTION.INCOMPLETE',
): Inspection => ({
  complete: false,
  findings: [
    {
      source,
      code,
      severity: 'error',
      message:
        'Inspection could not complete; verify connectivity, metadata permissions, timeout and cleanup.',
    },
  ],
});
function childEnvironment(url?: string): NodeJS.ProcessEnv {
  return {
    ...(url ? { DATABASE_URL: url } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.NODE_EXTRA_CA_CERTS
      ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
      : {}),
    TZ: 'UTC',
  };
}
/** Worker owns only diagnostic connections. Always observe process close before releasing its slot. */
export async function inspectInWorker(
  source: ResolvedSource,
  budget: number,
): Promise<Inspection> {
  if (stopping) return incomplete(source.name, 'INSPECTION.INTERRUPTED');
  const sourceMode = import.meta.url.endsWith('.ts');
  return new Promise((resolveResult) => {
    const child = own(
      fork(
        new URL(sourceMode ? './worker.ts' : './worker.js', import.meta.url),
        [],
        {
          execArgv: sourceMode ? ['--import', 'tsx'] : [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: childEnvironment(),
        },
      ),
    );
    let reply: Inspection | undefined,
      expired = false;
    const timer = setTimeout(
      () => {
        expired = true;
        child.kill('SIGKILL');
      },
      Math.max(1, budget),
    );
    child.on('message', (message) => {
      if (reply || !message || typeof message !== 'object') return;
      const value = message as Inspection;
      if (
        typeof value.complete !== 'boolean' ||
        !Array.isArray(value.findings) ||
        value.findings.length > 4096
      )
        return;
      const knownTargets = new Set(
        source.targets.map((t) => (t.schema ? t.schema + '.' : '') + t.table),
      );
      if (
        value.findings.some(
          (f) =>
            !f ||
            f.source !== source.name ||
            !/^([A-Z][A-Z0-9_.-]{0,95})$/.test(f.code) ||
            !['error', 'warning', 'info'].includes(f.severity) ||
            typeof f.message !== 'string' ||
            f.message.length > 512 ||
            (f.target !== undefined && !knownTargets.has(f.target)),
        )
      )
        return;
      reply = value;
    });
    child.on('error', () => {
      child.kill('SIGKILL');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult(
        !expired && code === 0 && reply ? reply : incomplete(source.name),
      );
    });
    child.send(source, (error) => {
      if (error) child.kill('SIGKILL');
    });
  });
}
const versions = {
  'tenant-audit': '0.2.0',
  'db-deploy-doctor': '0.2.0',
} as const;
export async function inspectWithPublishedTool(
  source: ResolvedSource,
  tool: keyof typeof versions,
  budget: number,
): Promise<Inspection> {
  if (stopping) return incomplete(source.name, 'INSPECTION.INTERRUPTED');
  if (budget <= 0) return incomplete(source.name, 'TOOL.TIMEOUT');
  const deadline = performance.now() + budget;
  let temporary: string | undefined;
  try {
    const require = createRequire(import.meta.url),
      manifestPath = require.resolve(tool + '/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      version: string;
      bin: Record<string, string>;
    };
    if (manifest.name !== tool || manifest.version !== versions[tool])
      return incomplete(source.name, 'TOOL.VERSION');
    const directory = dirname(manifestPath),
      bin = resolve(directory, manifest.bin[tool]!);
    if (!bin.startsWith(directory + sep))
      return incomplete(source.name, 'TOOL.INVALID');
    temporary = await mkdtemp(resolve(tmpdir(), 'tenantguard-cli-'));
    const config =
      tool === 'tenant-audit'
        ? {
            tables: Object.fromEntries(
              source.targets.map((target) => [
                (target.schema ??
                  (source.engine === 'postgres' ? 'public' : source.database)) +
                  '.' +
                  target.table,
                { tenantKey: target.tenantColumn },
              ]),
            ),
          }
        : {
            expectWritable: true,
            tablePrivileges: source.targets.map((target) => ({
              schema:
                target.schema ??
                (source.engine === 'postgres'
                  ? 'public'
                  : source.engine === 'sqlite'
                    ? 'main'
                    : source.database),
              table: target.table,
              privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
            })),
          };
    const path = resolve(temporary, 'requirements.json');
    await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    let url: string;
    if (source.engine === 'sqlite')
      url = pathToFileURL(source.filename!).href.replace(/^file:/, 'sqlite:');
    else {
      const value = new URL(source.url!);
      if (source.engine === 'postgres')
        value.searchParams.set(
          'sslmode',
          source.tls === 'verify' ? 'verify-full' : 'disable',
        );
      else if (source.tls === 'verify')
        value.searchParams.set('ssl-mode', 'verify-full');
      url = value.href;
    }
    if (stopping) return incomplete(source.name, 'INSPECTION.INTERRUPTED');
    const remaining = deadline - performance.now();
    if (remaining <= 0) return incomplete(source.name, 'TOOL.TIMEOUT');
    return await new Promise<Inspection>((resolveResult) => {
      const child = own(
        spawn(
          process.execPath,
          [
            bin,
            tool === 'tenant-audit' ? 'scan' : 'check',
            '--config',
            path,
            '--format',
            'json',
            '--fail-on',
            'none',
          ],
          {
            cwd: temporary,
            env: childEnvironment(url),
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        ),
      );
      let bytes = 0,
        output = '',
        expired = false;
      const timer = setTimeout(
        () => {
          expired = true;
          child.kill('SIGKILL');
        },
        Math.max(1, remaining),
      );
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) {
          expired = true;
          child.kill('SIGKILL');
        } else output += chunk;
      });
      child.on('error', () => {
        expired = true;
        child.kill('SIGKILL');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (expired || code !== 0) {
          resolveResult(incomplete(source.name, 'TOOL.INCOMPLETE'));
          return;
        }
        try {
          const report = JSON.parse(output);
          if (report.operationalError) throw new Error();
          const findings: Finding[] = [];
          if (tool === 'tenant-audit') {
            if (
              report.version !== versions[tool] ||
              !Array.isArray(report.findings)
            )
              throw new Error();
            const messages: Record<string, string> = {
              'TA-101': 'Declared tenant key is absent or nullable.',
              'TA-103':
                'Schema metadata alone cannot certify application tenant isolation.',
              'TA-104':
                'A configured relationship does not include matching tenant keys.',
              'TA-105':
                'A configured uniqueness constraint spans tenants; confirm this is intentional.',
              'TA-106':
                'The scanned role has elevated privileges or effective ownership.',
            };
            const targets = new Map(
              source.targets.map((target) => [
                (target.schema ??
                  (source.engine === 'postgres' ? 'public' : source.database)) +
                  '.' +
                  target.table,
                (target.schema ? target.schema + '.' : '') + target.table,
              ]),
            );
            for (const value of report.findings) {
              if (
                !messages[value.rule] ||
                !targets.has(value.table) ||
                !['high', 'medium', 'info'].includes(value.severity)
              )
                throw new Error();
              findings.push({
                source: source.name,
                code: value.rule,
                target: targets.get(value.table)!,
                severity:
                  value.severity === 'high'
                    ? 'error'
                    : value.severity === 'medium'
                      ? 'warning'
                      : 'info',
                message: messages[value.rule]!,
              });
            }
          } else {
            if (
              report.tool !== tool ||
              report.version !== versions[tool] ||
              !Array.isArray(report.checks)
            )
              throw new Error();
            for (const value of report.checks) {
              if (
                !/^DD-10[1-7]$/.test(value.id ?? value.code ?? '') ||
                !['pass', 'fail', 'warn', 'unsupported', 'unverified'].includes(
                  value.status,
                )
              )
                throw new Error();
              if (value.status !== 'pass')
                findings.push({
                  source: source.name,
                  code: value.id ?? value.code,
                  severity:
                    value.status === 'fail'
                      ? 'error'
                      : value.status === 'warn'
                        ? 'warning'
                        : 'info',
                  message:
                    value.status === 'fail'
                      ? 'Published deployment-doctor requirement was not met.'
                      : value.status === 'warn'
                        ? 'Published deployment-doctor check needs review.'
                        : 'Published deployment-doctor requirement is unverified or unsupported.',
                });
            }
          }
          findings.push({
            source: source.name,
            code:
              tool === 'tenant-audit'
                ? 'TOOL.TENANT_AUDIT'
                : 'TOOL.DEPLOY_DOCTOR',
            severity: 'info',
            message: `Reused ${tool} ${versions[tool]} through its published command.`,
          });
          resolveResult({ complete: true, findings });
        } catch {
          resolveResult(incomplete(source.name, 'TOOL.REPORT_INVALID'));
        }
      });
    });
  } catch {
    return incomplete(source.name, 'TOOL.INCOMPLETE');
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
