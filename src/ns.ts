/**
 * Mint a namespace token from a fork name. Baseline instances use "".
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
