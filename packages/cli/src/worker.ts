import { inspectSource } from './inspection.js';
import { inspectProbe } from './probes.js';
import type { IsolationProbe } from './probe-config.js';
import type { ResolvedSource } from './config.js';
process.once('message', async (message) => {
  try {
    const { source, probe } = message as {
      source: ResolvedSource;
      probe?: IsolationProbe;
    };
    let result = await inspectSource(source);
    if (probe) {
      const observation = await inspectProbe(source, probe);
      result = {
        findings: [...result.findings, ...observation.findings],
        complete: result.complete && observation.complete,
      };
    }
    process.send?.(result, () => process.disconnect());
  } catch {
    process.exitCode = 1;
    process.disconnect();
  }
});
