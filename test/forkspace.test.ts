import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseConfig, checkConfig, loadConfig } from "../src/config";
import { portFor, allocateSlot } from "../src/ports";
import { buildOverrideYaml, groupByComposeFile } from "../src/compose";
import { renderEnvFile, envToRecord, envFileName } from "../src/env";
import { nsFor } from "../src/ns";
import { portFor } from "../src/ports";
import { instanceKey, projectName } from "../src/state";

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
    expect(checkConfig(config, root)).toEqual([]);
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
