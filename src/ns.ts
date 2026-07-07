/**
 * Mint a namespace token from a fork name. Baseline instances use "" unless
 * `baselineNs` is configured (see `effectiveNs`).
 *
 * Rules: lowercase; dashes → underscores; strip non [a-z0-9_]; prefix f_
 * if the result would start with a digit; max 32 chars.
 */
export function nsFor(fork: string | null): string {
  if (fork == null || fork === "") return "";

  let s = fork.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]/g, "");
  if (/^\d/.test(s)) s = `f_${s}`;
  if (s.length > 32) s = s.slice(0, 32);
  return s;
}

/**
 * Dashed variant of the namespace token for engines that forbid underscores
 * (S3/GCS buckets, DNS labels, etc.). Derives from the same fork name as
 * `nsFor`: lowercase; underscores → dashes; strip non [a-z0-9-]; prefix f-
 * if the result would start with a digit; max 32 chars.
 */
export function nsDashFor(fork: string | null): string {
  if (fork == null || fork === "") return "";

  let s = fork.toLowerCase().replace(/_/g, "-").replace(/[^a-z0-9-]/g, "");
  if (/^\d/.test(s)) s = `f-${s}`;
  if (s.length > 32) s = s.slice(0, 32);
  return s;
}

/** Namespace token for an instance: fork token, or baselineNs for slot 0. */
export function effectiveNs(fork: string | null, baselineNs?: string): string {
  if (fork) return nsFor(fork);
  return baselineNs ?? "";
}
