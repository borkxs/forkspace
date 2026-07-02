import { z } from "zod";
import { parse } from "yaml";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A service that forkspace manages. Points at a service inside an existing
 * docker-compose file in one of the workspace repos. forkspace never owns
 * container definitions — it orchestrates the ones the repos already have.
 */
export const ServiceSchema = z.object({
  /** Path to the compose file that owns this service, relative to workspace root. */
  compose: z.string(),
  /** Service name inside that compose file. */
  service: z.string(),
  /** Host port for the baseline (slot 0) instance of this environment. */
  basePort: z.number().int().min(1).max(65535),
  /** Port inside the container. */
  containerPort: z.number().int().min(1).max(65535),
  /**
   * container  → each `--fork` gets its own compose service instance
   * namespace  → fork gets a namespace token inside the baseline's service
   * shared     → forks reuse the baseline service as-is
   */
  isolation: z.enum(["container", "namespace", "shared"]).default("container"),
  /**
   * Extra env vars to emit into the generated env file.
   * Values are templates: {port}, {host}, {service}, {ns}, {_ns} are substituted.
   * e.g. DATABASE_URL: "mysql://root:root@{host}:{port}/app"
   */
  exports: z.record(z.string(), z.string()).default({}),
});
export type ServiceDef = z.infer<typeof ServiceSchema>;

export const HooksSchema = z
  .object({
    /**
     * Command run after `up` completes, with the generated env file loaded.
     * Use for seeding test data.
     */
    seed: z.string().optional(),
    /**
     * Command run after containers are healthy, before seed.
     * This is where table/queue/bucket creation lives — deliberately a
     * pluggable command so the CDK-vs-Dynamoose source-of-truth question
     * doesn't block the tool. Point it at whichever wins.
     */
    bootstrap: z.string().optional(),
    /**
     * Command run when a fork comes up, before seed. Use for engine-specific
     * namespace/database creation (e.g. CREATE DATABASE).
     */
    forkCreate: z.string().optional(),
    /**
     * Command run when a fork goes down, before compose teardown.
     * Use for engine-specific namespace/database cleanup.
     */
    forkDestroy: z.string().optional(),
  })
  .default({});

export const AllocationSchema = z.object({
  /** Host port for the baseline (slot 0) instance of this allocation. */
  basePort: z.number().int().min(1).max(65535),
});
export type AllocationDef = z.infer<typeof AllocationSchema>;

export const EnvironmentSchema = z.object({
  /**
   * persistent: `down` keeps volumes (dev). Otherwise `down` runs with -v
   * and instances are truly ephemeral (test).
   */
  persistent: z.boolean().default(false),
  services: z.record(z.string(), ServiceSchema),
  /**
   * Named port slots forkspace reserves and exports but does not start
   * processes for. Same slot math as services (basePort + slot × slotSize).
   */
  allocations: z.record(z.string(), AllocationSchema).default({}),
  hooks: HooksSchema,
});
export type EnvironmentDef = z.infer<typeof EnvironmentSchema>;

export const ConfigSchema = z.object({
  /** Short workspace name, used as the compose project name prefix. */
  workspace: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "workspace must be lowercase alphanumeric/dash/underscore"),
  /**
   * Port distance between fork slots. Fork with slot N maps service ports to
   * basePort + N * slotSize. Default 10 → agent-a's mysql on 3316, agent-b's
   * on 3326, etc.
   */
  slotSize: z.number().int().min(1).default(10),
  environments: z.record(z.string(), EnvironmentSchema),
});
export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_FILENAME = "forkspace.yml";

/** Walk up from cwd to find the directory containing forkspace.yml. */
export function findRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILENAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No ${CONFIG_FILENAME} found in ${startDir} or any parent directory. ` +
          `Run \`forkspace init\` at your workspace root.`
      );
    }
    dir = parent;
  }
}

/** Reject v0.1 `scope` keys with a migration hint before zod runs. */
function rejectLegacyScope(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const envs = (data as Record<string, unknown>).environments;
  if (!envs || typeof envs !== "object") return;
  for (const [envName, env] of Object.entries(envs as Record<string, unknown>)) {
    if (!env || typeof env !== "object") continue;
    const services = (env as Record<string, unknown>).services;
    if (!services || typeof services !== "object") continue;
    for (const [svcName, svc] of Object.entries(services as Record<string, unknown>)) {
      if (svc && typeof svc === "object" && "scope" in svc) {
        throw new Error(
          `Invalid ${CONFIG_FILENAME}:\n` +
            `  environments.${envName}.services.${svcName}: ` +
            `"scope" was renamed to "isolation" (values: container | namespace | shared). ` +
            `Use "container" instead of "fork".`
        );
      }
    }
  }
}

export function parseConfig(raw: string): Config {
  const data = parse(raw);
  rejectLegacyScope(data);
  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${CONFIG_FILENAME}:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(root: string): Config {
  const file = path.join(root, CONFIG_FILENAME);
  return parseConfig(readFileSync(file, "utf8"));
}

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

/** Compose file + service identity for shared-baseline port claims. */
type PortClaim = {
  env: string;
  label: string;
  basePort: number;
  compose?: string;
  service?: string;
};

function composeServiceKey(claim: PortClaim): string | null {
  if (claim.compose && claim.service) return `${claim.compose}\0${claim.service}`;
  return null;
}

/** Same compose file + service identity for shared-baseline port claims. */
function sameComposeService(a: PortClaim, b: PortClaim): boolean {
  const ka = composeServiceKey(a);
  return ka !== null && ka === composeServiceKey(b);
}

/** Same basePort is allowed only for the same compose service shared across environments. */
function isSharedBaselinePair(a: PortClaim, b: PortClaim): boolean {
  return sameComposeService(a, b) && a.basePort === b.basePort;
}

function exportTemplatesUseNs(exports: Record<string, string>): boolean {
  return Object.values(exports).some((v) => v.includes("{ns}") || v.includes("{_ns}"));
}

/**
 * Static validation of a config against the filesystem and itself:
 *  - referenced compose files exist and define the referenced services
 *  - port claims are workspace-global (services + allocations)
 *  - fork port ranges can't collide across environments unless sharing one baseline
 *  - exports keys must not use the reserved FORKSPACE_ prefix (warning)
 *  - namespace-isolated services should reference {ns} or {_ns} in exports (warning)
 */
export function checkConfig(config: Config, root: string): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const claims: PortClaim[] = [];

  for (const [envName, env] of Object.entries(config.environments)) {
    for (const [svcName, svc] of Object.entries(env.services)) {
      const composePath = path.join(root, svc.compose);
      if (!existsSync(composePath)) {
        errors.push(`${envName}.${svcName}: compose file not found: ${svc.compose}`);
      } else {
        try {
          const doc = parse(readFileSync(composePath, "utf8"));
          if (!doc?.services?.[svc.service]) {
            errors.push(
              `${envName}.${svcName}: service "${svc.service}" not defined in ${svc.compose}`
            );
          }
        } catch (e) {
          errors.push(`${envName}.${svcName}: failed to parse ${svc.compose}: ${e}`);
        }
      }

      claims.push({
        env: envName,
        label: `${envName}.${svcName}`,
        basePort: svc.basePort,
        compose: svc.compose,
        service: svc.service,
      });

      for (const key of Object.keys(svc.exports)) {
        if (key.startsWith("FORKSPACE_")) {
          warnings.push(
            `${envName}.${svcName}: export key "${key}" uses the reserved FORKSPACE_ prefix — ` +
              `forkspace owns that namespace for generated vars.`
          );
        }
      }

      if (svc.isolation === "namespace" && !exportTemplatesUseNs(svc.exports)) {
        warnings.push(
          `${envName}.${svcName}: namespace isolation but exports omit {ns}/{_ns} — ` +
            `forks would silently share the baseline namespace.`
        );
      }
    }

    for (const [allocName, alloc] of Object.entries(env.allocations)) {
      claims.push({
        env: envName,
        label: `${envName}.allocations.${allocName}`,
        basePort: alloc.basePort,
      });
    }
  }

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (isSharedBaselinePair(a, b)) continue;

      if (a.basePort === b.basePort) {
        errors.push(
          `"${a.label}" and "${b.label}" both claim basePort ${a.basePort} — ` +
            `only the same compose service may share a port across environments.`
        );
        continue;
      }

      if (sameComposeService(a, b)) continue;

      const diff = Math.abs(a.basePort - b.basePort);
      if (diff % config.slotSize === 0 && diff < config.slotSize * 32) {
        errors.push(
          `"${a.label}" (${a.basePort}) and "${b.label}" (${b.basePort}) are ` +
            `${diff} apart, a multiple of slotSize ${config.slotSize} — fork slot ` +
            `${diff / config.slotSize} of one collides with the other's baseline.`
        );
      }
    }
  }

  return { errors, warnings };
}
