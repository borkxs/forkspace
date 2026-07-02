import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { portFor, allocateSlot } from "../src/ports";
import { buildOverrideYaml, groupByComposeFile } from "../src/compose";
import { renderEnvFile, envToRecord, envFileName } from "../src/env";
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
        scope: shared
`;

describe("config", () => {
  it("parses with defaults applied", () => {
    const cfg = parseConfig(MINIMAL_YML);
    expect(cfg.slotSize).toBe(10);
    expect(cfg.environments.test.persistent).toBe(false);
    expect(cfg.environments.test.services.mysql.scope).toBe("fork");
    expect(cfg.environments.test.services.dynamodb.scope).toBe("shared");
  });

  it("rejects bad workspace names", () => {
    expect(() => parseConfig(MINIMAL_YML.replace("acme", "Sun Bound"))).toThrow(
      /workspace/
    );
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
        scope: "fork" as const,
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
      entries: [
        {
          name: "mysql",
          def: {
            compose: "x.yml",
            service: "db",
            basePort: 3406,
            containerPort: 3306,
            scope: "fork",
            exports: { DATABASE_URL: "mysql://root:root@{host}:{port}/app" },
          },
          hostPort: 3416,
        },
      ],
    });
    const rec = envToRecord(content);
    expect(rec.FORKSPACE_ENV).toBe("test");
    expect(rec.FORKSPACE_FORK).toBe("agent-a");
    expect(rec.FORKSPACE_MYSQL_PORT).toBe("3416");
    expect(rec.DATABASE_URL).toBe("mysql://root:root@127.0.0.1:3416/app");
  });

  it("names env files by env and fork", () => {
    expect(envFileName("test", null)).toBe(".env.forkspace.test");
    expect(envFileName("test", "agent-a")).toBe(".env.forkspace.test.agent-a");
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
