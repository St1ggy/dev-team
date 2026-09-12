import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RpcClient } from './rpc-client.js';

export async function runGateway(): Promise<void> {
  const url = requiredEnv('DEV_TEAM_CONTROL_URL');
  const token = requiredEnv('DEV_TEAM_CONTROL_TOKEN');
  const role = requiredEnv('DEV_TEAM_ROLE') as 'main' | 'worker';
  const agentId = requiredEnv('DEV_TEAM_AGENT_ID');
  if (role !== 'main' && role !== 'worker') throw new Error(`Invalid gateway role: ${role}`);
  const rpc = new RpcClient(url, token, role, agentId);
  const server = new McpServer({ name: 'dev-team', version: '0.1.0' });

  if (role === 'main') registerMainTools(server, rpc);
  else registerWorkerTools(server, rpc);
  await server.connect(new StdioServerTransport());
}

function registerMainTools(server: McpServer, rpc: RpcClient): void {
  server.tool('task_create_delivery', 'Create an explicit delivery scope and its final delivery task.', {
    title: z.string(), description: z.string().optional(), priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  }, (input) => result(rpc.call('create_delivery', input)));

  server.tool('task_create', 'Create a small work task inside a delivery scope.', {
    scope_id: z.string(), title: z.string(), description: z.string().optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    depends_on: z.array(z.string()).optional(),
  }, ({ scope_id, depends_on, ...input }) => result(rpc.call('create_work', { scopeId: scope_id, dependsOn: depends_on, ...input })));

  server.tool('task_set_dependencies', 'Replace a task dependency list.', {
    task_id: z.string(), depends_on: z.array(z.string()),
  }, ({ task_id, depends_on }) => result(rpc.call('set_dependencies', { taskId: task_id, dependsOn: depends_on })));

  server.tool('task_list', 'List all ATC tasks.', {}, () => result(rpc.call('list_tasks')));

  server.tool('task_wait', 'Wait until selected tasks reach one of the requested statuses.', {
    task_ids: z.array(z.string()).min(1),
    statuses: z.array(z.enum(['todo', 'locked', 'in_progress', 'review', 'done', 'failed'])).default(['review', 'done', 'failed']),
    timeout_seconds: z.number().int().min(1).max(3600).default(600),
  }, ({ task_ids, statuses, timeout_seconds }) => result(rpc.call('wait_tasks', { taskIds: task_ids, statuses, timeoutSeconds: timeout_seconds })));

  server.tool('worker_dispatch', 'Claim a ready task and launch an isolated OpenCode worker.', {
    task_id: z.string(),
  }, ({ task_id }) => result(rpc.call('dispatch', { taskId: task_id })));

  server.tool('task_review', 'Approve or reject a task in Review. Approval integrates work or creates the delivery PR.', {
    task_id: z.string(), verdict: z.enum(['approve', 'reject']), comment: z.string().optional(),
  }, ({ task_id, ...input }) => result(rpc.call('review', { taskId: task_id, ...input })));

  server.tool('workspace_diff', 'Read the review diff for a task workspace.', {
    task_id: z.string(),
  }, ({ task_id }) => result(rpc.call('diff', { taskId: task_id })));

  server.tool('scope_diff', 'Read the aggregate diff for a delivery scope.', {
    scope_id: z.string(),
  }, ({ scope_id }) => result(rpc.call('scope_diff', { scopeId: scope_id })));

  server.tool('runtime_recovery_status', 'List interrupted durable operations requiring recovery.', {}, () => result(rpc.call('recovery_status')));
}

function registerWorkerTools(server: McpServer, rpc: RpcClient): void {
  server.tool('task_get', 'Get your current task and detailed ATC state.', {}, () => result(rpc.call('worker_task')));

  server.tool('task_progress', 'Report progress and renew the task lock.', {
    message: z.string(),
  }, (input) => result(rpc.call('progress', input)));

  server.tool('workspace_checkpoint', 'Create a durable provider-native checkpoint.', {}, () => result(rpc.call('checkpoint')));

  server.tool('workspace_diff', 'Show all changes in your isolated workspace.', {}, () => result(rpc.call('worker_diff')));

  server.tool('task_submit', 'Checkpoint and submit completed work for internal Review.', {}, () => result(rpc.call('submit')));

  server.tool('task_release', 'Release the task without discarding its workspace.', {
    reason: z.string().optional(),
  }, (input) => result(rpc.call('release', input)));
}

async function result(value: Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await value, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
