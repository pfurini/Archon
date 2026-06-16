// Archon path resolution utilities
export {
  expandTilde,
  isDocker,
  getArchonHome,
  getArchonWorkspacesPath,
  ensureArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonConfigPath,
  getArchonEnvPath,
  getRepoArchonEnvPath,
  getHomeWorkflowsPath,
  getHomeCommandsPath,
  getHomeScriptsPath,
  getLegacyHomeWorkflowsPath,
  getCommandFolderSearchPaths,
  getWorkflowFolderSearchPaths,
  getAppArchonBasePath,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  logArchonPaths,
  validateAppDefaultsPaths,
  parseOwnerRepo,
  getProjectRoot,
  getProjectSourcePath,
  getProjectWorktreesPath,
  getProjectArtifactsPath,
  getProjectLogsPath,
  getRunArtifactsPath,
  getRunLogPath,
  resolveProjectRootFromCwd,
  ensureProjectStructure,
  createProjectSourceSymlink,
  findMarkdownFilesRecursive,
  getWebDistDir,
} from './archon-paths';

// Env loader
export { loadArchonEnv, isVerboseBoot } from './env-loader';

// Env var name validation (shared by launch boundary, API schema, config loader)
export { ENV_VAR_NAME_PATTERN, isValidEnvVarName } from './env-name';

// Archon-internal-infra env denylist (mirror of stripCwdEnv)
export { ARCHON_INTERNAL_ENV_KEYS, buildTargetCommandEnv } from './archon-internal-env';

// Logger
export { createLogger, setLogLevel, getLogLevel, rootLogger } from './logger';
export type { Logger } from './logger';

// Build-time constants (rewritten by scripts/build-binaries.sh)
export { BUNDLED_IS_BINARY, BUNDLED_VERSION, BUNDLED_GIT_COMMIT } from './bundled-build';

// Update check
export {
  checkForUpdate,
  getCachedUpdateCheck,
  isNewerVersion,
  parseLatestRelease,
} from './update-check';
export type { UpdateCheckResult } from './update-check';

// Anonymous telemetry
export {
  captureWorkflowInvoked,
  captureArchonStarted,
  captureArchonActive,
  captureChatTurn,
  captureApprovalResolved,
  captureCodebaseRegistered,
  captureWorkflowCompleted,
  classifyWorkflowForTelemetry,
  TELEMETRY_SCHEMA_VERSION,
  shutdownTelemetry,
  isTelemetryDisabled,
  getTelemetryStatus,
  resetTelemetryId,
} from './telemetry';
export type {
  WorkflowInvokedProperties,
  ArchonStartedProperties,
  ChatTurnProperties,
  DeploymentShapeProperties,
  WorkflowCompletedProperties,
  WorkflowExitReason,
  WorkflowErrorClass,
  WorkflowNodeType,
  WorkflowTelemetrySource,
  TelemetryStatus,
  TelemetryDisabledReason,
} from './telemetry';
