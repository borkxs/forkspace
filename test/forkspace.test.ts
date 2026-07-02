import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseConfig, checkConfig, loadConfig } from "../src/config";
import { portFor, allocateSlot } from "../src/ports";
import { buildOverrideYaml, groupByComposeFile } from "../src/compose";
import { renderEnvFile, envToRecord, envFileName } from "../src/env";
import { nsFor } from "../src/ns";
import { instanceKey, projectName, type State } from "../src/state";
import {
  containerIsolated,
  planInstance,
  planSlotProbe,
} from "../src/plan";

const MINIMAL_YML = `
workspace: acme
environments:
  test:
    services:
      mysql:
        compose: my-api/docker-compose.yml
        service: db
        basePort: 3406
        containerPort: 3306
      dynamodb:
        compose: my-api/docker-compose.yml
        service: dynamodb
        basePort: 8100
        containerPort: 8000
        isolation: shared
`;

describe("config", () => {
  it("parses with defaults applied", () => {
    const cfg = parseConfig(MINIMAL_YML);
    expect(cfg.slotSize).toBe(10);
    expect(cfg.environments.test.persistent).toBe(false);
    expect(cfg.environments.test.allocations).toEqual({});
    expect(cfg.environments.test.services.mysql.isolation).toBe("container");
    expect(cfg.environments.test.services.dynamodb.isolation).toBe("shared");
  });

  it("parses allocations and fork hooks", () => {
    const yml = `
workspace: app
environments:
  test:
    allocations:
      app:
        basePort: 4100
    services:
      mysql:
        compose: api/docker-compose.yml
        service: db
        basePort: 3406
        containerPort: 3306
    hooks:
      forkCreate: ./scripts/fork-create.sh
      forkDestroy: ./scripts/fork-destroy.sh
`;
    const cfg = parseConfig(yml);
    expect(cfg.environments.test.allocations.app.basePort).toBe(4100);
    expect(cfg.environments.test.hooks.forkCreate).toBe("./scripts/fork-create.sh");
    expect(cfg.environments.test.hooks.forkDestroy).toBe("./scripts/fork-destroy.sh");
  });

  it("rejects legacy scope keys with a migration hint", () => {
    expect(() =>
      parseConfig(MINIMAL_YML.replace("isolation: shared", "scope: shared"))
    ).toThrow(/scope.*renamed to.*isolation/i);
  });

  it("rejects bad workspace names", () => {
    expect(() => parseConfig(MINIMAL_YML.replace("acme", "Sun Bound"))).toThrow(
      /workspace/
    );
  });

  it("check passes against fixture workspace", () => {
    const root = path.join(__dirname, "fixtures", "workspace");
    const config = loadConfig(root);
    expect(checkConfig(config, root)).toEqual({ errors: [], warnings: [] });
  });

  it("allows the same compose service on the same basePort across environments", () => {
    const root = path.join(__dirname, "fixtures", "workspace");
    const config = loadConfig(root);
    const { errors } = checkConfig(config, root);
    expect(errors.filter((e) => e.includes("8000"))).toEqual([]);
  });

  it("flags different services claiming the same basePort across environments", () => {
    const root = path.join(__dirname, "fixtures", "workspace");
    const config = loadConfig(root);
    config.environments.test.services.queue.basePort = 8000;
    const { errors } = checkConfig(config, root);
    expect(errors.some((e) => e.includes("8000"))).toBe(true);
  });

  it("warns on FORKSPACE_ export keys", () => {
    const root = path.join(__dirname, "fixtures", "workspace");
    const config = loadConfig(root);
    config.environments.test.services.mysql.exports.FORKSPACE_CUSTOM = "oops";
    const { warnings } = checkConfig(config, root);
    expect(warnings.some((w) => w.includes("FORKSPACE_CUSTOM"))).toBe(true);
  });

  it("warns when namespace exports omit {ns}/{_ns}", () => {
    const root = path.join(__dirname, "fixtures", "workspace");
    const config = loadConfig(root);
    config.environments.test.services.mysql.exports.DATABASE_URL =
      "mysql://root:root@{host}:{port}/acmepay";
    const { warnings } = checkConfig(config, root);
    expect(warnings.some((w) => w.includes("namespace isolation"))).toBe(true);
  });
});

describe("ports", () => {
  it("slot 0 is the base port", () => {
    expect(portFor(3406, 0, 10)).toBe(3406);
  });
  it("forks step by slotSize", () => {
    expect(portFor(3406, 1, 10)).toBe(3416);
    expect(portFor(8100, 3, 10)).toBe(8130);
  });
  it("allocateSlot skips taken slots", async () => {
    // Use ports in a range almost certainly free in test env.
    const slot = await allocateSlot({
      basePorts: [45300],
      slotSize: 10,
      takenSlots: new Set([1, 2]),
      minSlot: 1,
    });
    expect(slot).toBe(3);
  });
});

describe("compose override", () => {
  const planned = [
    {
      name: "mysql",
      def: {
        compose: "my-api/docker-compose.yml",
        service: "db",
        basePort: 3406,
        containerPort: 3306,
        isolation: "container" as const,
        exports: {},
      },
      hostPort: 3416,
    },
  ];

  it("emits !override port bindings", () => {
    const yml = buildOverrideYaml(planned);
    expect(yml).toContain("db:");
    expect(yml).toContain("ports: !override");
    expect(yml).toContain('"3416:3306"');
  });

  it("groups services by owning compose file", () => {
    const two = [
      planned[0],
      {
        ...planned[0],
        name: "queue",
        def: { ...planned[0].def, compose: "other/docker-compose.yml", service: "elasticmq" },
        hostPort: 9324,
      },
    ];
    const groups = groupByComposeFile(two);
    expect(groups.size).toBe(2);
    expect(groups.get("my-api/docker-compose.yml")!.length).toBe(1);
  });
});

describe("env file", () => {
  it("renders standard vars and export templates", () => {
    const content = renderEnvFile({
      env: "test",
      fork: "agent-a",
      project: "fs-acme-test-agent-a",
      ns: "agent_a",
      entries: [
        {
          name: "mysql",
          def: {
            compose: "x.yml",
            service: "db",
            basePort: 3406,
            containerPort: 3306,
            isolation: "container",
            exports: { DATABASE_URL: "mysql://root:root@{host}:{port}/app" },
          },
          hostPort: 3416,
        },
      ],
    });
    const rec = envToRecord(content);
    expect(rec.FORKSPACE_ENV).toBe("test");
    expect(rec.FORKSPACE_FORK).toBe("agent-a");
    expect(rec.FORKSPACE_NS).toBe("agent_a");
    expect(rec.FORKSPACE_MYSQL_PORT).toBe("3416");
    expect(rec.DATABASE_URL).toBe("mysql://root:root@127.0.0.1:3416/app");
  });

  it("renders {ns} and {_ns} in export templates", () => {
    const forkContent = renderEnvFile({
      env: "test",
      fork: "agent-a",
      project: "fs-acme-test-agent-a",
      ns: "agent_a",
      entries: [
        {
          name: "mysql",
          def: {
            compose: "x.yml",
            service: "db",
            basePort: 3406,
            containerPort: 3306,
            isolation: "namespace",
            exports: {
              DATABASE_URL: "mysql://root:1@{host}:{port}/acme_test{_ns}",
            },
          },
          hostPort: 3416,
        },
      ],
    });
    expect(envToRecord(forkContent).DATABASE_URL).toBe(
      "mysql://root:1@127.0.0.1:3416/acme_test_agent_a"
    );

    const baselineContent = renderEnvFile({
      env: "test",
      fork: null,
      project: "fs-acme-test",
      ns: "",
      entries: [
        {
          name: "mysql",
          def: {
            compose: "x.yml",
            service: "db",
            basePort: 3406,
            containerPort: 3306,
            isolation: "namespace",
            exports: {
              DATABASE_URL: "mysql://root:1@{host}:{port}/acme_test{_ns}",
            },
          },
          hostPort: 3406,
        },
      ],
    });
    expect(envToRecord(baselineContent).DATABASE_URL).toBe(
      "mysql://root:1@127.0.0.1:3406/acme_test"
    );
    expect(envToRecord(baselineContent).FORKSPACE_NS).toBe("");
  });

  it("emits allocation ports at slot-adjusted values", () => {
    const slotSize = 10;
    const appBase = 4100;

    const baseline = renderEnvFile({
      env: "test",
      fork: null,
      project: "fs-acme-test",
      ns: "",
      entries: [],
      allocations: [{ name: "app", hostPort: portFor(appBase, 0, slotSize) }],
    });
    expect(envToRecord(baseline).FORKSPACE_APP_PORT).toBe("4100");

    const fork = renderEnvFile({
      env: "test",
      fork: "agent-a",
      project: "fs-acme-test-agent-a",
      ns: "agent_a",
      entries: [],
      allocations: [{ name: "app", hostPort: portFor(appBase, 1, slotSize) }],
    });
    const rec = envToRecord(fork);
    expect(rec.FORKSPACE_NS).toBe("agent_a");
    expect(rec.FORKSPACE_APP_PORT).toBe("4110");
  });

  it("names env files by env and fork", () => {
    expect(envFileName("test", null)).toBe(".env.forkspace.test");
    expect(envFileName("test", "agent-a")).toBe(".env.forkspace.test.agent-a");
  });
});

describe("namespace tokens", () => {
  it("returns empty string for baseline", () => {
    expect(nsFor(null)).toBe("");
    expect(nsFor("")).toBe("");
  });

  it("lowercases and converts dashes to underscores", () => {
    expect(nsFor("agent-a")).toBe("agent_a");
    expect(nsFor("E2E-1")).toBe("e2e_1");
  });

  it("prefixes f_ when the token would start with a digit", () => {
    expect(nsFor("1st")).toBe("f_1st");
  });

  it("strips invalid characters", () => {
    expect(nsFor("Agent.A@2")).toBe("agenta2");
  });

  it("truncates to 32 characters", () => {
    const long = "abcdefghijklmnopqrstuvwxyz0123456789extra";
    expect(long.length).toBeGreaterThan(32);
    expect(nsFor(long)).toBe("abcdefghijklmnopqrstuvwxyz012345");
    expect(nsFor(long).length).toBe(32);
  });

  it("truncates after f_ prefix when needed", () => {
    const long = "1" + "a".repeat(40);
    expect(nsFor(long)).toBe(`f_1${"a".repeat(29)}`);
    expect(nsFor(long).length).toBe(32);
  });
});

describe("naming", () => {
  it("instance keys and project names", () => {
    expect(instanceKey("test", null)).toBe("test");
    expect(instanceKey("test", "agent-a")).toBe("test@agent-a");
    expect(projectName("acme", "test", "agent-a")).toBe("fs-acme-test-agent-a");
    expect(projectName("acme", "dev", null)).toBe("fs-acme-dev");
  });
});

const TEST_ENV = parseConfig(MINIMAL_YML).environments.test;
const SLOT_SIZE = 10;

function emptyState(): State {
  return { instances: {} };
}

describe("planInstance", () => {
  it("baseline starts all services and runs bootstrap → seed", () => {
    const env = {
      ...TEST_ENV,
      hooks: {
        bootstrap: "npm run bootstrap",
        seed: "npm run seed",
        forkCreate: "./fork-create.sh",
        forkDestroy: "./fork-destroy.sh",
      },
    };
    const plan = planInstance({
      config: { workspace: "acme", slotSize: SLOT_SIZE, environments: { test: env } },
      env,
      envName: "test",
      fork: null,
      state: emptyState(),
      isolateSet: null,
      slot: 0,
    });

    expect(plan.containersToStart.map((s) => s.name).sort()).toEqual(["dynamodb", "mysql"]);
    expect(plan.ns).toBe("");
    expect(plan.backing).toBe("container");
    expect(plan.requiresBaseline).toBe(false);
    expect(plan.hooks.up).toEqual(["npm run bootstrap", "npm run seed"]);
    expect(plan.hooks.down).toBeUndefined();
    expect(plan.ports.mysql).toBe(3406);
    expect(plan.ports.dynamodb).toBe(8100);
  });

  it("container-isolated fork starts only container services", () => {
    const env = {
      ...TEST_ENV,
      services: {
        mysql: { ...TEST_ENV.services.mysql, isolation: "container" as const },
        dynamodb: { ...TEST_ENV.services.dynamodb, isolation: "shared" as const },
      },
      hooks: { seed: "npm run seed" },
    };
    const state: State = {
      instances: {
        test: {
          key: "test",
          env: "test",
          fork: null,
          slot: 0,
          project: "fs-acme-test",
          ns: "",
          backing: "container",
          ports: { mysql: 3406, dynamodb: 8100 },
          services: ["mysql", "dynamodb"],
          envFile: ".env.forkspace.test",
          createdAt: "",
        },
      },
    };
    const plan = planInstance({
      config: { workspace: "acme", slotSize: SLOT_SIZE, environments: { test: env } },
      env,
      envName: "test",
      fork: "agent-a",
      state,
      isolateSet: null,
      slot: 1,
    });

    expect(plan.containersToStart.map((s) => s.name)).toEqual(["mysql"]);
    expect(plan.containersToStart[0].hostPort).toBe(3416);
    expect(plan.ports.mysql).toBe(3416);
    expect(plan.ports.dynamodb).toBe(8100);
    expect(plan.ns).toBe("agent_a");
    expect(plan.backing).toBe("container");
    expect(plan.requiresBaseline).toBe(true);
    expect(plan.baselineDependentServices).toEqual(["dynamodb"]);
    expect(plan.hooks.up).toEqual(["npm run seed"]);
  });

  it("namespace-only fork has no containers and runs forkCreate → seed", () => {
    const env = {
      ...TEST_ENV,
      services: {
        mysql: { ...TEST_ENV.services.mysql, isolation: "namespace" as const },
        dynamodb: { ...TEST_ENV.services.dynamodb, isolation: "shared" as const },
      },
      hooks: {
        forkCreate: "./fork-create.sh",
        seed: "npm run seed",
        forkDestroy: "./fork-destroy.sh",
      },
    };
    const state: State = {
      instances: {
        test: {
          key: "test",
          env: "test",
          fork: null,
          slot: 0,
          project: "fs-acme-test",
          ns: "",
          backing: "container",
          ports: { mysql: 3406, dynamodb: 8100 },
          services: ["mysql", "dynamodb"],
          envFile: ".env.forkspace.test",
          createdAt: "",
        },
      },
    };
    const plan = planInstance({
      config: { workspace: "acme", slotSize: SLOT_SIZE, environments: { test: env } },
      env,
      envName: "test",
      fork: "agent-a",
      state,
      isolateSet: null,
      slot: 2,
    });

    expect(plan.containersToStart).toEqual([]);
    expect(plan.containerServiceNames).toEqual([]);
    expect(plan.backing).toBe("namespace-only");
    expect(plan.ports.mysql).toBe(3406);
    expect(plan.ports.dynamodb).toBe(8100);
    expect(plan.hooks.up).toEqual(["./fork-create.sh", "npm run seed"]);
    expect(plan.hooks.down).toBe("./fork-destroy.sh");
  });

  it("planSlotProbe includes only container services and allocations", () => {
    const env = {
      ...TEST_ENV,
      allocations: { app: { basePort: 4100 } },
      services: {
        mysql: { ...TEST_ENV.services.mysql, isolation: "namespace" as const },
        dynamodb: { ...TEST_ENV.services.dynamodb, isolation: "container" as const },
      },
    };
    expect(
      planSlotProbe({ env, fork: "agent-a", isolateSet: null }).sort((a, b) => a - b)
    ).toEqual([4100, 8100]);
    expect(planSlotProbe({ env, fork: null, isolateSet: null })).toEqual([]);
  });

  it("--isolate forces listed services to container isolation", () => {
    const env = {
      ...TEST_ENV,
      services: {
        mysql: { ...TEST_ENV.services.mysql, isolation: "namespace" as const },
        dynamodb: { ...TEST_ENV.services.dynamodb, isolation: "shared" as const },
      },
    };
    const isolateSet = new Set(["mysql"]);
    expect(containerIsolated("mysql", env, isolateSet)).toBe(true);
    expect(containerIsolated("dynamodb", env, isolateSet)).toBe(false);

    const plan = planInstance({
      config: { workspace: "acme", slotSize: SLOT_SIZE, environments: { test: env } },
      env,
      envName: "test",
      fork: "agent-a",
      state: {
        instances: {
          test: {
            key: "test",
            env: "test",
            fork: null,
            slot: 0,
            project: "fs-acme-test",
            ns: "",
            backing: "container",
            ports: { mysql: 3406, dynamodb: 8100 },
            services: ["mysql", "dynamodb"],
            envFile: ".env.forkspace.test",
            createdAt: "",
          },
        },
      },
      isolateSet,
      slot: 1,
    });
    expect(plan.containersToStart.map((s) => s.name)).toEqual(["mysql"]);
    expect(plan.baselineDependentServices).toEqual(["dynamodb"]);
  });
});
