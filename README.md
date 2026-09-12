# dev-team

`dev-team` runs an OpenCode orchestrator and isolated workers around an ATC Kanban board. Version-control operations are owned by provider implementations instead of being executed by agents.

The MVP supports:

- Git worktrees with one aggregate GitHub draft PR per delivery scope.
- Directories without VCS through immutable snapshots and conflict-checked delivery.
- Additional VCS implementations supplied as plugins.

Jujutsu and Mercurial are intentionally deferred until the provider contract has stabilized.

## Requirements

- Node.js 22 for ATC. The repository pins `22.16.0` through mise.
- OpenCode available as `opencode`.
- Git repositories: `git`, `gh`, an authenticated GitHub account, and a clean source workspace.

ATC is always launched with a Node 22 executable, even if the outer CLI is invoked another way. Detection checks, in order:

1. `--atc-node`
2. `DEV_TEAM_ATC_NODE`
3. The current executable when it is Node 22
4. `mise where node@22`
5. Homebrew's `node@22`

Install and verify:

```bash
mise install
mise x node@22 -- npm install
mise x node@22 -- npm run build
mise x node@22 -- npm test
```

Install the package globally:

```bash
npm install --global @st1ggy/dev-team
```

Or run the setup wizard without installing it:

```bash
npx --yes @st1ggy/dev-team setup
```

The wizard writes `dev-team.config.json` in the selected project. `init` is an alias for `setup`:

```bash
npx --yes @st1ggy/dev-team init /path/to/project --provider git --base-ref main
```

## Start

```bash
npm run start -- doctor /path/to/project
npm run start -- start /path/to/project
```

Or after linking/installing the package:

```bash
dev-team doctor /path/to/project
dev-team start /path/to/project
```

Provider detection prefers Git and falls back to NoVCS. Override it when necessary:

```bash
dev-team start . --provider git --base-ref main --workers 4
dev-team start . --provider novcs
```

Load a plugin from the target project's dependencies or from a relative file:

```bash
dev-team start . --plugin @example/dev-team-provider --provider example
dev-team start . --plugin ./dev-team-provider.mjs --provider example
```

The command prints the dashboard URL and opens the OpenCode orchestrator. The orchestrator receives only the `dev-team` MCP gateway. It creates explicit delivery scopes, small work tasks, dependencies, and isolated workers.

## Delivery Flow

Every final PR or milestone is represented by an explicit delivery task:

```text
delivery scope
  work task A ─┐
  work task B ─┼─> delivery task ─> one draft PR
  work task C ─┘
```

Workers checkpoint and submit their task for internal Review. Approval integrates the checkpoint into the scope's aggregate workspace. The delivery task becomes claimable only after all dependencies are done. Its approval creates the final draft PR.

Git worker refs remain local until aggregation. Only the aggregate branch is pushed to GitHub.

NoVCS leaves the source directory unchanged while work tasks run. It applies the aggregate snapshot only when the delivery task is approved, after checking every changed path against the original baseline. A backup and apply journal are retained.

## Configuration

An optional `dev-team.config.json` can be placed in the selected project directory:

```json
{
  "provider": "git",
  "plugins": ["@example/dev-team-provider"],
  "baseRef": "main",
  "workers": 4,
  "port": 4000,
  "model": "provider/model",
  "opencodeCommand": "opencode",
  "atcNodeCommand": "/path/to/node-22/bin/node"
}
```

Runtime state is stored outside the project under the platform state directory. Set `DEV_TEAM_HOME` to override it.

## Provider Plugins

A provider plugin exports a `DevTeamPlugin` as its default export or as `plugin`. Package specifiers are resolved from the target project; relative paths are resolved from the project root.

```ts
import type { DevTeamPlugin } from '@st1ggy/dev-team';

const plugin: DevTeamPlugin = {
  name: 'example-provider',
  deniedCommands: ['example-vcs'],
  createProviders: ({ runner }) => [new ExampleProvider(runner)],
};

export default plugin;
```

Each provider implements the exported `VcsProvider` interface. Plugin providers are checked before the built-in Git and NoVCS providers, and their `deniedCommands` are added to OpenCode's worker permissions.

## Recovery And Safety

- ATC runs with `workspace_mode: disabled`; its Git-only workspace and merge implementation are not used.
- The coordination daemon owns all VCS commands and serializes integration within each delivery scope.
- Provider side effects are recorded before the ATC task is marked done.
- Retrying Review is idempotent. Existing commits and PRs are detected rather than duplicated.
- Conflicts leave the task in Review and preserve both worker and aggregate workspaces.
- No workspace or private branch is deleted automatically.
- `dev-team status` and `dev-team recover` list interrupted operations. Retry the corresponding `task_review` after inspecting the workspace.
- OpenCode workers are denied direct VCS commands. The orchestrator is also denied direct file edits.

ATC's upstream HTTP server currently controls its own bind address and has no authentication. Run `dev-team` only on a trusted workstation/network and do not expose the dashboard port through port forwarding.

## Development

```bash
mise x node@22 -- npm run typecheck
mise x node@22 -- npm test
mise x node@22 -- npm run build
```

Real GitHub PR creation is not exercised by the default tests. Git tests use a command runner double and therefore do not create branches or PRs.
