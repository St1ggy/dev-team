import type {
  Checkpoint,
  CreateWorkspaceInput,
  DiffArtifact,
  DoctorCheck,
  IntegrationReceipt,
  ProjectRecord,
  ProviderCapabilities,
  Submission,
  SubmitInput,
  WorkspaceRecord,
} from '../core/types.js';

export interface DetectedRepository {
  root: string;
  baseRef: string;
  projectRelativePath: string;
}

export interface VcsProvider {
  readonly kind: ProjectRecord['provider'];
  readonly capabilities: ProviderCapabilities;
  detect(path: string): Promise<DetectedRepository | null>;
  doctor(project: ProjectRecord): Promise<DoctorCheck[]>;
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  checkpoint(project: ProjectRecord, workspace: WorkspaceRecord, message: string): Promise<Checkpoint>;
  diff(project: ProjectRecord, workspace: WorkspaceRecord): Promise<DiffArtifact>;
  submit(input: SubmitInput): Promise<Submission>;
  integrate(
    project: ProjectRecord,
    source: WorkspaceRecord,
    aggregate: WorkspaceRecord,
  ): Promise<IntegrationReceipt>;
  applyDelivery(project: ProjectRecord, aggregate: WorkspaceRecord): Promise<IntegrationReceipt>;
  archive(workspace: WorkspaceRecord): Promise<void>;
  cleanup(project: ProjectRecord, workspace: WorkspaceRecord): Promise<void>;
}
