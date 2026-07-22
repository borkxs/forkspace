export const STARTER_CONFIG = `# forkspace.yml — workspace-level environment definitions
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
        isolation: namespace   # fork gets its own database namespace
        exports:
          DATABASE_URL: "mysql://root:root@{host}:{port}/{ns}"
      dynamodb:
        compose: api/docker-compose.yml
        service: dynamodb
        basePort: 8100
        containerPort: 8000
        isolation: shared      # forks reuse the baseline instance
    hooks:
      bootstrap: npm run db:create-tables
      seed: npm run db:seed-test
      forkCreate: ./scripts/fork-create.sh
      forkDestroy: ./scripts/fork-destroy.sh
      listNamespaces: ./scripts/list-namespaces.sh
`;
