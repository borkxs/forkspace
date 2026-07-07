export type Isolation = "container" | "namespace" | "shared";

export interface ServiceDef {
  compose: string;
  service: string;
  basePort: number;
  containerPort: number;
  isolation?: Isolation;
  exports: Record<string, string>;
}

export interface AllocationDef {
  basePort: number;
}

export interface HooksDef {
  bootstrap?: string;
  seed?: string;
  forkCreate?: string;
  forkDestroy?: string;
  listNamespaces?: string;
}

export interface EnvironmentDef {
  persistent?: boolean;
  baselineNs?: string;
  services: Record<string, ServiceDef>;
  allocations?: Record<string, AllocationDef>;
  hooks?: HooksDef;
}

export interface Config {
  workspace: string;
  slotSize: number;
  environments: Record<string, EnvironmentDef>;
}

export interface InstanceRecord {
  key: string;
  env: string;
  fork: string | null;
  slot: number;
  project: string;
  ns: string;
  backing: "container" | "namespace-only";
  ports: Record<string, number>;
  services: string[];
  envFile: string;
  createdAt: string;
}

export interface State {
  instances: Record<string, InstanceRecord>;
}

export type OutputLine =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "warn"; text: string }
  | { kind: "env"; text: string };

export interface CommandResult {
  lines: OutputLine[];
  exitCode: number;
}
