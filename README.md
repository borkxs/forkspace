# forkspace

`forkspace` is a standalone CLI for managing isolated local dev/test environments
for multi-repo, multi-service stacks.

## Core idea

`forkspace` is not just port parametrization. It is a workspace-level compose
manager with:

- a config file as the source of environment definitions
- named environments (for example `dev`, `test`)
- agent/developer forking (`forkspace up test --fork agent-a`)
- cross-repo service deduplication

The intended value is full isolation per fork: each fork gets its own MySQL,
DynamoDB/LocalStack, and SQS resources without affecting other forks.

## Why this is non-trivial

- Cross-repo compose conflict detection is required (for example, two repos
  claiming port `8000` for DynamoDB with incompatible configs).
- CDK as infra source of truth and Dynamoose as app-level schema must be
  reconciled before reliable table bootstrap is possible.
- The local table/queue bootstrap path is currently unclear and needs agent scan
  findings before implementation details are finalized.

## Open question before full build

The key blocker is whether CDK is the real source of truth for table structure,
or whether Dynamoose `autoCreate` behavior is load-bearing.

- If CDK is authoritative, bootstrap can be driven directly from infra
  definitions.
- If Dynamoose `autoCreate` is required, `forkspace` must either run apps in a
  bootstrap mode or extract schema from Dynamoose models for table creation.

This answer determines the final implementation scope.

## Positioning

This project is standalone (not part of `@b2bkit`) and sits in the same family
as Hookrelay and Envgate: developer infrastructure tooling rather than library
primitives.