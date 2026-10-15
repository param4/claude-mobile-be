// Types shared by the Mac server and the mobile app.
import { z } from 'zod';

export const SessionStatus = z.enum(['active', 'archived', 'all']);
export const GroupBy = z.enum(['date', 'project', 'state', 'none']);
export const SortBy = z.enum(['recency', 'alpha', 'created']);

export const SessionQuery = z.object({
  project: z.string().optional(),
  status: SessionStatus.default('active'),
  groupBy: GroupBy.default('date'),
  sort: SortBy.default('recency'),
  q: z.string().trim().min(1).optional(),
});
export type SessionQuery = z.infer<typeof SessionQuery>;

export const SessionSummary = z.object({
  id: z.string(),
  cliSessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  // Sessions the desktop app started without a folder share one "No folder" project.
  projectKey: z.string(),
  projectName: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  archived: z.boolean(),
  pinned: z.boolean(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
  lastPrompt: z.string().optional(),
  // Set while this server is running the session.
  liveState: z.enum(['working', 'needs-input']).optional(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const SessionGroup = z.object({
  key: z.string(),
  label: z.string(),
  sessions: z.array(SessionSummary),
});
export type SessionGroup = z.infer<typeof SessionGroup>;

export const Project = z.object({
  key: z.string(),
  name: z.string(),
  path: z.string(),
  sessionCount: z.number(),
  lastActivityAt: z.number(),
  pinned: z.boolean(),
});
export type Project = z.infer<typeof Project>;

export const ToolResult = z.object({
  text: z.string(),
  isError: z.boolean(),
  truncated: z.boolean(),
});

export const ChatItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string(), text: z.string(), timestamp: z.string().optional() }),
  z.object({ kind: z.literal('assistant'), id: z.string(), text: z.string(), timestamp: z.string().optional() }),
  z.object({ kind: z.literal('thinking'), id: z.string(), text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    id: z.string(),
    name: z.string(),
    summary: z.string(),
    input: z.unknown(),
    result: ToolResult.optional(),
  }),
]);
export type ChatItem = z.infer<typeof ChatItem>;

export const ProjectsResponse = z.object({ projects: z.array(Project) });
export const SessionsResponse = z.object({ groups: z.array(SessionGroup) });
export const MessagesResponse = z.object({
  session: SessionSummary,
  items: z.array(ChatItem),
  hasMore: z.boolean(),
});
export type MessagesResponse = z.infer<typeof MessagesResponse>;


// ---- Live chat over WebSocket (/api/ws) ----

export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;
export const PermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']);
export type PermissionMode = z.infer<typeof PermissionMode>;
export const LiveState = z.enum(['idle', 'working', 'needs-input']);
export type LiveState = z.infer<typeof LiveState>;

export const LiveSettings = z.object({
  model: z.string().optional(),
  effort: Effort.optional(),
  permissionMode: PermissionMode,
});
export type LiveSettings = z.infer<typeof LiveSettings>;

export const CommandInfo = z.object({ name: z.string(), description: z.string(), argumentHint: z.string() });
export type CommandInfo = z.infer<typeof CommandInfo>;
export const ModelOption = z.object({
  value: z.string(),
  // The full model id an alias like "opus" points at, to match a session's stored model.
  resolvedModel: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  efforts: z.array(Effort),
});
export type ModelOption = z.infer<typeof ModelOption>;

export const Question = z.object({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean(),
  options: z.array(z.object({ label: z.string(), description: z.string() })),
});
export type Question = z.infer<typeof Question>;

export const PendingPermission = z.object({
  requestId: z.string(),
  toolName: z.string(),
  summary: z.string(),
  input: z.unknown(),
  canAlwaysAllow: z.boolean(),
  questions: z.array(Question).optional(),
});
export type PendingPermission = z.infer<typeof PendingPermission>;

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), sessionId: z.string() }),
  z.object({ type: z.literal('unsubscribe'), sessionId: z.string() }),
  z.object({ type: z.literal('send'), sessionId: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal('interrupt'), sessionId: z.string() }),
  z.object({
    type: z.literal('settings'),
    sessionId: z.string(),
    model: z.string().optional(),
    effort: Effort.optional(),
    permissionMode: PermissionMode.optional(),
  }),
  z.object({
    type: z.literal('permission'),
    sessionId: z.string(),
    requestId: z.string(),
    decision: z.enum(['allow', 'allowAlways', 'deny']),
    message: z.string().optional(),
    // AskUserQuestion: question text -> chosen label(s), comma-joined for multi-select.
    answers: z.record(z.string(), z.string()).optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type ServerMessage =
  | {
      type: 'snapshot';
      sessionId: string;
      state: LiveState;
      settings: LiveSettings;
      pending: PendingPermission[];
      draft: string;
      // Items of the turn in progress.
      recent: ChatItem[];
    }
  | { type: 'catalog'; sessionId: string; commands: CommandInfo[]; models: ModelOption[] }
  | { type: 'state'; sessionId: string; state: LiveState }
  | { type: 'settings'; sessionId: string; settings: LiveSettings }
  | { type: 'item'; sessionId: string; item: ChatItem }
  | { type: 'tool_result'; sessionId: string; toolId: string; result: z.infer<typeof ToolResult> }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'permission'; sessionId: string; pending: PendingPermission }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  | { type: 'turn_end'; sessionId: string; ok: boolean; error?: string; costUsd?: number }
  | { type: 'notice'; sessionId: string; text: string }
  | { type: 'error'; sessionId?: string; message: string };

// Encoded in the pairing QR code.
export const PairingPayload = z.object({
  v: z.literal(1),
  url: z.string().url(),
  token: z.string().min(32),
  name: z.string(),
});
export type PairingPayload = z.infer<typeof PairingPayload>;

// ---- Starting chats from the phone ----
export const CreateSessionRequest = z.object({
  project: z.string(),
  text: z.string().min(1),
  model: z.string().optional(),
  effort: Effort.optional(),
  permissionMode: PermissionMode.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;
export const CreateSessionResponse = z.object({ sessionId: z.string() });

export const CatalogResponse = z.object({
  commands: z.array(CommandInfo),
  models: z.array(ModelOption),
  defaults: LiveSettings,
});
export type CatalogResponse = z.infer<typeof CatalogResponse>;
