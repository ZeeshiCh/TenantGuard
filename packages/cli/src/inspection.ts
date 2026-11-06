import type { ResolvedSource, Target } from './config.js';
import type { Finding, Severity } from './report.js';
import type { Inspection } from './processes.js';
export interface Observer {
  add(code: string, severity: Severity, message: string, target?: Target): void;
  unknown(code: string, message: string, target?: Target): void;
  result(): Inspection;
}
export function observer(source: ResolvedSource): Observer {
  const findings: Finding[] = [];
  let complete = true;
  const add = (
    code: string,
    severity: Severity,
    message: string,
    target?: Target,
  ) =>
    findings.push({
      source: source.name,
      code,
      severity,
      message,
      ...(target
        ? { target: (target.schema ? target.schema + '.' : '') + target.table }
        : {}),
    });
  return {
    add,
    unknown(code, message, target) {
      complete = false;
      add(code, 'error', message, target);
    },
    result: () => ({ complete, findings }),
  };
}
export async function inspectSource(
  source: ResolvedSource,
): Promise<Inspection> {
  const output = observer(source);
  try {
    if (source.engine === 'postgres')
      await (await import('./postgres.js')).inspectPostgres(source, output);
    else if (source.engine === 'sqlserver')
      await (await import('./sqlserver.js')).inspectSqlServer(source, output);
    else if (source.engine === 'mysql' || source.engine === 'mariadb')
      await (await import('./mysql.js')).inspectMysql(source, output);
    else if (source.engine === 'mongodb')
      await (await import('./mongodb.js')).inspectMongo(source, output);
    else await (await import('./sqlite.js')).inspectSqlite(source, output);
  } catch {
    output.unknown(
      'INSPECTION.INCOMPLETE',
      'Catalog inspection or cleanup failed; check connectivity, permissions and declared targets.',
    );
  }
  return output.result();
}
