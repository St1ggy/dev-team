export type ProviderKind = 'git' | 'novcs' | (string & {});
export type TaskKind = 'work' | 'delivery';
export type WorkspaceKind = 'task' | 'aggregate';

export interface ProjectRecord {
  id: string;
  root: string;
  provider: ProviderKind;
  baseRef: string;
  projectRelativePath: string;
}

export interface ScopeRecord {
  id: string;
  projectId: string;
  title: string;
  deliveryTaskId: string | null;
  aggregateWorkspaceId: string | null;
  status: string;
}

export interface TaskRecord {
  taskId: string;
  scopeId: string;
  kind: TaskKind;
  workspaceId: string | null;
  checkpoint: string | null;
  submission: string | null;
  integration: string | null;
}

export interface WorkspaceRecord {
  id: string;
  projectId: string;
  scopeId: string;
  taskId: string | null;
  kind: WorkspaceKind;
  root: string;
  projectPath: string;
  ref: string;
  baseRevision: string;
  status: 'active' | 'archived' | 'deleted';
  metadata: string;
}

export interface Checkpoint {
  id: string;
  revision: string;
  clean: boolean;
}

export interface DiffArtifact {
  text: string;
  files: string[];
}

export interface Submission {
  kind: 'local-ref' | 'remote-branch' | 'pull-request' | 'snapshot';
  revision: string;
  reference?: string;
  url?: string;
  number?: string;
}

export interface IntegrationReceipt {
  revision: string;
  alreadyApplied: boolean;
  details?: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface ProviderCapabilities {
  isolatedWorkspace: boolean;
  localCheckpoints: boolean;
  aggregateIntegration: boolean;
  remoteSubmission: boolean;
  draftPullRequest: boolean;
}

export interface CreateWorkspaceInput {
  project: ProjectRecord;
  scopeId: string;
  taskId?: string;
  kind: WorkspaceKind;
  workspaceRoot: string;
  baseWorkspace?: WorkspaceRecord;
}

export interface SubmitInput {
  project: ProjectRecord;
  workspace: WorkspaceRecord;
  title: string;
  body: string;
  final: boolean;
}
