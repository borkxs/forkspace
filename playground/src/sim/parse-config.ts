import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Config } from "./types";

const ServiceSchema = z.object({
  compose: z.string(),
  service: z.string(),
  basePort: z.number().int().min(1).max(65535),
  containerPort: z.number().int().min(1).max(65535),
  isolation: z.enum(["container", "namespace", "shared"]).default("container"),
  exports: z.record(z.string(), z.string()).default({}),
});

const HooksSchema = z
  .object({
    seed: z.string().optional(),
    bootstrap: z.string().optional(),
    forkCreate: z.string().optional(),
    forkDestroy: z.string().optional(),
    listNamespaces: z.string().optional(),
  })
  .default({});

const AllocationSchema = z.object({
  basePort: z.number().int().min(1).max(65535),
});

const EnvironmentSchema = z.object({
  baselineNs: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .optional(),
  persistent: z.boolean().default(false),
  services: z.record(z.string(), ServiceSchema),
  allocations: z.record(z.string(), AllocationSchema).default({}),
  hooks: HooksSchema,
});

const ConfigSchema = z.object({
  workspace: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  slotSize: z.number().int().min(1).default(10),
  environments: z.record(z.string(), EnvironmentSchema),
});

/** Compose files that exist in the simulated workspace. */
const SIMULATED_COMPOSE: Record<string, string[]> = {
  "my-api/docker-compose.yml": ["db", "dynamodb", "elasticmq", "minio"],
  "api/docker-compose.yml": ["db", "dynamodb"],
};

const NS_TOKENS = ["{ns}", "{_ns}", "{ns_}", "{nsdash}", "{_nsdash}", "{nsdash_}"];

export interface ParseResult {
  ok: true;
  config: Config;
}

export interface ParseError {
  ok: false;
  message: string;
}

export function parseConfigYaml(raw: string): ParseResult | ParseError {
  try {
    const data = parse(raw);
    rejectLegacyScope(data);
    const result = ConfigSchema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      return { ok: false, message: `Invalid forkspace.yml:\n${issues}` };
    }
    return { ok: true, config: result.data as Config };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

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
          `environments.${envName}.services.${svcName}: "scope" was renamed to "isolation"`
        );
      }
    }
  }
}

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

type PortClaim = {
  env: string;
  label: string;
  basePort: number;
  compose?: string;
  service?: string;
};

export function checkConfig(config: Config): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const claims: PortClaim[] = [];

  for (const [envName, env] of Object.entries(config.environments)) {
    for (const [svcName, svc] of Object.entries(env.services)) {
      const services = SIMULATED_COMPOSE[svc.compose];
      if (!services) {
        errors.push(`${envName}.${svcName}: compose file not found: ${svc.compose}`);
      } else if (!services.includes(svc.service)) {
        errors.push(
          `${envName}.${svcName}: service "${svc.service}" not defined in ${svc.compose}`
        );
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
            `${envName}.${svcName}: export key "${key}" uses the reserved FORKSPACE_ prefix`
          );
        }
      }

      if (svc.isolation === "namespace") {
        const usesNs = Object.values(svc.exports).some((v) =>
          NS_TOKENS.some((t) => v.includes(t))
        );
        if (!usesNs) {
          warnings.push(
            `${envName}.${svcName}: namespace isolation but exports omit {ns} templates`
          );
        }
      }
    }

    for (const [allocName, alloc] of Object.entries(env.allocations ?? {})) {
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
      const sameCompose =
        a.compose && b.compose && a.compose === b.compose && a.service === b.service;
      if (sameCompose && a.basePort === b.basePort) continue;

      if (a.basePort === b.basePort) {
        errors.push(
          `"${a.label}" and "${b.label}" both claim basePort ${a.basePort}`
        );
        continue;
      }

      if (sameCompose) continue;

      const diff = Math.abs(a.basePort - b.basePort);
      if (diff % config.slotSize === 0 && diff < config.slotSize * 32) {
        errors.push(
          `"${a.label}" (${a.basePort}) and "${b.label}" (${b.basePort}) slot ranges overlap`
        );
      }
    }
  }

  return { errors, warnings };
}

export function configToYaml(config: Config): string {
  return stringify(config);
}
