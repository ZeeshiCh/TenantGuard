export type Severity = 'error' | 'warning' | 'info';
export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly source?: string;
  readonly target?: string;
  readonly message: string;
}
export interface ReportScope {
  readonly source: string;
  readonly engine: string;
  readonly mode: string;
  readonly targets: readonly string[];
}
export interface DiagnosticReport {
  readonly version: 1;
  readonly command: 'doctor' | 'audit' | 'unknown';
  readonly connected: boolean;
  readonly complete: boolean;
  readonly outcome:
    'invalid-config' | 'incomplete' | 'issues-found' | 'no-errors-observed';
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly findings: readonly Finding[];
  readonly scope: readonly ReportScope[];
  readonly limitations: readonly string[];
}
export function makeReport(
  command: DiagnosticReport['command'],
  connected: boolean,
  findings: readonly Finding[],
  options: {
    invalid?: boolean;
    incomplete?: boolean;
    failOn?: 'error' | 'warning';
    scope?: readonly ReportScope[];
  } = {},
): DiagnosticReport {
  const sorted = [...findings].sort((a, b) =>
    JSON.stringify([
      a.source ?? '',
      a.target ?? '',
      a.code,
      a.severity,
    ]).localeCompare(
      JSON.stringify([b.source ?? '', b.target ?? '', b.code, b.severity]),
      'en',
    ),
  );
  const issues = sorted.some(
    (f) =>
      f.severity === 'error' ||
      (options.failOn === 'warning' && f.severity === 'warning'),
  );
  const exitCode = options.invalid
    ? 2
    : options.incomplete
      ? 3
      : issues
        ? 1
        : 0;
  return Object.freeze({
    version: 1,
    command,
    connected,
    complete: !options.invalid && !options.incomplete,
    outcome: options.invalid
      ? 'invalid-config'
      : options.incomplete
        ? 'incomplete'
        : issues
          ? 'issues-found'
          : 'no-errors-observed',
    exitCode,
    scope: Object.freeze(
      (options.scope ?? []).map((item) =>
        Object.freeze({ ...item, targets: Object.freeze([...item.targets]) }),
      ),
    ),
    findings: Object.freeze(sorted.map((f) => Object.freeze({ ...f }))),
    limitations: Object.freeze([
      'Findings cover declared targets and the connected role; collectors can inspect broader catalogs. Missing or inaccessible metadata is not a passed check.',
      'Catalog observations and supported template recognition do not certify tenant isolation, arbitrary policy semantics, application query scoping or production readiness.',
      'No business rows, cross-tenant write probes, DDL, grants or migrations are executed. Application-filter engines require the scoped application API.',
    ]),
  });
}
export function renderReport(report: DiagnosticReport, json = false): string {
  if (json) return JSON.stringify(report, null, 2) + '\n';
  return (
    [
      `TenantGuard ${report.command}: ${report.outcome} (exit ${report.exitCode})`,
      ...report.scope.map(
        (item) =>
          `Source ${item.source}: ${item.engine} / ${item.mode}; targets ${item.targets.join(', ')}`,
      ),
      ...report.findings.map(
        (f) =>
          `[${f.severity.toUpperCase()}] ${f.code}${f.source ? ' ' + f.source : ''}${f.target ? ' ' + f.target : ''}: ${f.message}`,
      ),
      ...report.limitations.map((value) => 'Scope: ' + value),
    ].join('\n') + '\n'
  );
}
