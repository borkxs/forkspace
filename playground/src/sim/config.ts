import type { Config } from "./types";
import { stringify } from "yaml";

/** Demo workspace config — mirrors forkspace.example.yml */
export const DEMO_CONFIG: Config = {
  workspace: "acme",
  slotSize: 10,
  environments: {
    dev: {
      persistent: true,
      services: {
        mysql: {
          compose: "my-api/docker-compose.yml",
          service: "db",
          basePort: 3306,
          containerPort: 3306,
          exports: {
            DATABASE_URL: "mysql://root:root@{host}:{port}/acmepay",
          },
        },
        dynamodb: {
          compose: "my-api/docker-compose.yml",
          service: "dynamodb",
          basePort: 8000,
          containerPort: 8000,
          exports: {
            DYNAMO_ENDPOINT: "http://{host}:{port}",
          },
        },
        queue: {
          compose: "my-api/docker-compose.yml",
          service: "elasticmq",
          basePort: 9324,
          containerPort: 9324,
          exports: {
            SQS_ENDPOINT: "http://{host}:{port}",
          },
        },
        s3: {
          compose: "my-api/docker-compose.yml",
          service: "minio",
          basePort: 9000,
          containerPort: 9000,
          exports: {
            S3_ENDPOINT: "http://{host}:{port}",
          },
        },
      },
    },
    test: {
      persistent: false,
      baselineNs: "main",
      allocations: {
        app: { basePort: 4100 },
      },
      services: {
        mysql: {
          compose: "my-api/docker-compose.yml",
          service: "db",
          basePort: 3406,
          containerPort: 3306,
          isolation: "namespace",
          exports: {
            DATABASE_URL: "mysql://root:root@{host}:{port}/{ns}",
          },
        },
        dynamodb: {
          compose: "my-api/docker-compose.yml",
          service: "dynamodb",
          basePort: 8100,
          containerPort: 8000,
          isolation: "shared",
          exports: {
            DYNAMO_ENDPOINT: "http://{host}:{port}",
          },
        },
        queue: {
          compose: "my-api/docker-compose.yml",
          service: "elasticmq",
          basePort: 9424,
          containerPort: 9324,
          isolation: "shared",
          exports: {
            SQS_ENDPOINT: "http://{host}:{port}",
          },
        },
        s3: {
          compose: "my-api/docker-compose.yml",
          service: "minio",
          basePort: 9100,
          containerPort: 9000,
          isolation: "shared",
          exports: {
            S3_ENDPOINT: "http://{host}:{port}",
          },
        },
      },
      hooks: {
        bootstrap: "npm --prefix my-api run local:bootstrap",
        seed: "npm --prefix my-api run local:seed-test",
        forkCreate: "my-api/scripts/fork-create.sh",
        forkDestroy: "my-api/scripts/fork-destroy.sh",
        listNamespaces: "my-api/scripts/list-namespaces.sh",
      },
    },
  },
};

export const DEMO_CONFIG_YAML = stringify(DEMO_CONFIG);

export const STARTER_CONFIG_YAML = `# forkspace.yml — workspace-level environment definitions
workspace: myapp
slotSize: 10

environments:
  dev:
    persistent: true
    services:
      mysql:
        compose: api/docker-compose.yml
        service: db
        basePort: 3306
        containerPort: 3306
        exports:
          DATABASE_URL: "mysql://root:root@{host}:{port}/app"

  test:
    persistent: false
    baselineNs: main
    allocations:
      app:
        basePort: 4100
    services:
      mysql:
        compose: api/docker-compose.yml
        service: db
        basePort: 3406
        containerPort: 3306
        isolation: namespace
        exports:
          DATABASE_URL: "mysql://root:root@{host}:{port}/{ns}"
      dynamodb:
        compose: api/docker-compose.yml
        service: dynamodb
        basePort: 8100
        containerPort: 8000
        isolation: shared
    hooks:
      bootstrap: npm run db:create-tables
      seed: npm run db:seed-test
      forkCreate: ./scripts/fork-create.sh
      forkDestroy: ./scripts/fork-destroy.sh
      listNamespaces: ./scripts/list-namespaces.sh
`;
