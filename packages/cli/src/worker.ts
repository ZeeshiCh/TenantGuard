import { inspectSource } from './inspection.js';
import type { ResolvedSource } from './config.js';
process.once('message', async (source) => {
  try {
    const result = await inspectSource(source as ResolvedSource);
    process.send?.(result, () => process.disconnect());
  } catch {
    process.exitCode = 1;
    process.disconnect();
  }
});
