export function assertChaosAllowed(): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('FATAL: Chaos framework must never run in production');
  }
  if (process.env['CHAOS_ENABLED'] !== 'true') {
    throw new Error('Chaos framework not enabled. Set CHAOS_ENABLED=true');
  }
}
