export function nsFor(fork: string | null): string {
  if (fork == null || fork === "") return "";
  let s = fork.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]/g, "");
  if (/^\d/.test(s)) s = `f_${s}`;
  if (s.length > 32) s = s.slice(0, 32);
  return s;
}

export function nsDashFor(fork: string | null): string {
  if (fork == null || fork === "") return "";
  let s = fork.toLowerCase().replace(/_/g, "-").replace(/[^a-z0-9-]/g, "");
  if (/^\d/.test(s)) s = `f-${s}`;
  if (s.length > 32) s = s.slice(0, 32);
  return s;
}

export function effectiveNs(fork: string | null, baselineNs?: string): string {
  if (fork) return nsFor(fork);
  return baselineNs ?? "";
}
