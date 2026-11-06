#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { main } from './api.js';
import { stopDiagnosticChildren } from './processes.js';
export * from './api.js';
export { parseDiagnosticConfig } from './config.js';
export type { DiagnosticConfig, DiagnosticSource, Target } from './config.js';
export type { DiagnosticReport, Finding, Severity } from './report.js';
let direct = false;
try {
  direct =
    !!process.argv[1] &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  direct = false;
}
if (direct) {
  let interrupted = false;
  const stop = (code: number) => {
    interrupted = true;
    process.exitCode = code;
    stopDiagnosticChildren();
  };
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
  process.stdout.on('error', () => {
    process.exitCode = 3;
    stopDiagnosticChildren();
  });
  void main(process.argv.slice(2), {
    write: (text) => {
      if (!interrupted) process.stdout.write(text);
    },
  }).then(
    (code) => {
      if (!interrupted) process.exitCode = code;
    },
    () => {
      if (!interrupted) {
        process.stderr.write('TenantGuard diagnostic execution failed.\n');
        process.exitCode = 3;
      }
    },
  );
}
