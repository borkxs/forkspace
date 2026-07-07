export interface ScenarioStep {
  title: string;
  description: string;
  command?: string;
  /** Interactive step — no terminal command */
  action?: "edit-yaml";
  hint?: string;
}

export interface Scenario {
  id: string;
  title: string;
  subtitle: string;
  diagram?: string;
  /** Reset to empty workspace (no forkspace.yml) before the walkthrough */
  freshWorkspace?: boolean;
  steps: ScenarioStep[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "getting-started",
    title: "Getting started",
    subtitle: "init → edit → check → first up",
    freshWorkspace: true,
    steps: [
      {
        title: "Initialize config",
        description:
          "Write a starter forkspace.yml at your workspace root. This declares environments, services, ports, and hooks.",
        command: "forkspace init",
      },
      {
        title: "Edit forkspace.yml",
        description:
          "Customize your workspace name, services, ports, and isolation levels. The editor on the right opens after init — try changing workspace to your project name, or swap api/ paths to match your repo layout.",
        action: "edit-yaml",
        hint: "Starter config uses api/docker-compose.yml — simulated as present in this playground.",
      },
      {
        title: "Validate workspace",
        description:
          "Check compose files exist, services are defined, and port ranges don't collide across environments.",
        command: "forkspace check",
      },
      {
        title: "Start dev environment",
        description:
          "Bring up your persistent dev baseline. Volumes survive restarts and `down`.",
        command: "forkspace up dev",
      },
      {
        title: "List instances",
        description: "See what's running — slot, namespace, project name, and ports.",
        command: "forkspace ls",
      },
    ],
  },
  {
    id: "local-tests",
    title: "Local tests",
    subtitle: "ephemeral baseline for test runs",
    steps: [
      {
        title: "Start test baseline",
        description:
          "A clean, seeded stack on its own ports. Runs bootstrap → seed hooks.",
        command: "forkspace up test",
      },
      {
        title: "Source env file",
        description:
          "Export connection strings and ports into your shell. Apps and tests consume the same contract.",
        command: "forkspace env test",
        hint: "In a real shell: source <(forkspace env test)",
      },
      {
        title: "Run your tests",
        description: "With env sourced, run npm test, vitest, etc. against the isolated stack.",
        command: "npm test",
        hint: "Simulated — this playground doesn't run your tests",
      },
      {
        title: "Tear down",
        description:
          "Drop volumes for non-persistent environments. No state drifts between runs.",
        command: "forkspace down test",
      },
    ],
  },
  {
    id: "parallel-agents",
    title: "Parallel agents",
    subtitle: "fork per agent, shared baseline services",
    steps: [
      {
        title: "Start test baseline",
        description: "One MySQL container hosts many namespace databases.",
        command: "forkspace up test",
      },
      {
        title: "Agent A fork",
        description:
          "Each agent gets its own slot, env file, and MySQL database — no corrupted feedback loops.",
        command: "forkspace up test --fork agent-a",
      },
      {
        title: "Agent B fork",
        description: "Second agent on different ports and namespace. DynamoDB/S3 stay shared.",
        command: "forkspace up test --fork agent-b",
      },
      {
        title: "Inspect forks",
        description: "See all instances, slots, and namespace tokens side by side.",
        command: "forkspace ls",
      },
      {
        title: "Tear down agent A",
        description: "Remove one fork without affecting others.",
        command: "forkspace down test --fork agent-a",
      },
    ],
  },
  {
    id: "puppeteer",
    title: "Puppeteer / browser e2e",
    subtitle: "app port allocation per fork",
    steps: [
      {
        title: "Start test baseline",
        description: "Backing services come up via compose.",
        command: "forkspace up test",
      },
      {
        title: "Fork for e2e run",
        description:
          "forkspace reserves FORKSPACE_APP_PORT from the allocations block — start your app on it.",
        command: "forkspace up test --fork e2e-1",
      },
      {
        title: "Get app port",
        description: "Find FORKSPACE_APP_PORT in the env file and point Puppeteer at it.",
        command: "forkspace env test --fork e2e-1",
      },
      {
        title: "Clean up",
        description: "Tear down the fork when done.",
        command: "forkspace down test --fork e2e-1",
      },
    ],
  },
  {
    id: "db-migration",
    title: "DB migration in isolation",
    subtitle: "--isolate upgrades one service to container isolation",
    steps: [
      {
        title: "Start test baseline",
        description: "Baseline MySQL serves all agent namespaces.",
        command: "forkspace up test",
      },
      {
        title: "Isolated migration fork",
        description:
          "A fresh MySQL with its own volume. Migration work won't touch shared namespaces.",
        command: "forkspace up test --fork migrate-x --isolate mysql",
      },
      {
        title: "Run migrations",
        description: "Source the fork env and run destructive migration scripts safely.",
        command: "forkspace env test --fork migrate-x",
      },
      {
        title: "Tear down migration fork",
        description: "Drop the isolated MySQL when done.",
        command: "forkspace down test --fork migrate-x",
      },
    ],
  },
  {
    id: "ci-shard",
    title: "CI sharding",
    subtitle: "parallel test shards with --no-hooks",
    steps: [
      {
        title: "Shard up (no hooks)",
        description:
          "CI skips lifecycle hooks — run migrate/seed yourself from the correct checkout.",
        command: "forkspace up test --fork 0 --no-hooks",
      },
      {
        title: "Source shard env",
        description: "Each CI node gets its own namespace and ports.",
        command: "forkspace env test --fork 0",
      },
      {
        title: "Shard down",
        description: "Clean up after the test run.",
        command: "forkspace down test --fork 0",
      },
    ],
  },
  {
    id: "orphan-audit",
    title: "Orphan audit",
    subtitle: "ls --orphans diffs engine vs state",
    steps: [
      {
        title: "Start baseline + forks",
        description: "Set up a realistic multi-fork state.",
        command: "forkspace up test",
      },
      {
        title: "Add another fork",
        description: "",
        command: "forkspace up test --fork agent-a",
      },
      {
        title: "Audit namespaces",
        description:
          "Compare recorded fork namespaces against hooks.listNamespaces output. Finds orphans and ghosts.",
        command: "forkspace ls --orphans",
      },
    ],
  },
  {
    id: "cleanup",
    title: "Cleanup after crashes",
    subtitle: "prune stranded docker projects",
    steps: [
      {
        title: "Dry run prune",
        description: "See what would be removed without making changes.",
        command: "forkspace prune --dry-run",
      },
      {
        title: "Prune for real",
        description: "Remove stranded compose projects and orphaned env files.",
        command: "forkspace prune",
      },
    ],
  },
];
