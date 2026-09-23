export function proxyCapabilityEnabled(value: string | undefined, capability: string): boolean {
  // The current managed controller never uses the old tenant acquire/release
  // routes. Keep that unsafe protocol closed even when Sandbox is enabled.
  if (capability === 'sandbox') {
    return false;
  }
  if (!value) {
    return true;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)[capability] === true
    );
  } catch {
    return false;
  }
}
