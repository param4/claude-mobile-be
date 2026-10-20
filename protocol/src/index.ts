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

// An image the app loads from the Mac, by a path relative to the server (sent with the bearer token).
export const ImageRef = z.object({ url: z.string() });
export type ImageRef = z.infer<typeof ImageRef>;

export const ChatItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    id: z.string(),
    text: z.string(),
    timestamp: z.string().optional(),
    images: z.array(ImageRef).optional(),
    // Names of non-image files attached to the message.
    files: z.array(z.string()).optional(),
  }),
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
  fastMode: z.boolean().optional(),
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
  z.object({
    type: z.literal('send'),
    sessionId: z.string(),
    text: z.string(),
    // Upload ids from POST /api/uploads.
    attachments: z.array(z.string()).max(10).optional(),
    // Edit, retry or rewind: drop this user message and everything after it before sending.
    rewindTo: z.string().optional(),
    // With rewindTo: also restore files Claude changed since that message.
    rewindFiles: z.boolean().optional(),
  }),
  // Dry run of a code rewind, answered with a rewind_preview message.
  z.object({ type: z.literal('rewind_preview'), sessionId: z.string(), messageId: z.string() }),
  z.object({ type: z.literal('interrupt'), sessionId: z.string() }),
  z.object({
    type: z.literal('settings'),
    sessionId: z.string(),
    model: z.string().optional(),
    effort: Effort.optional(),
    permissionMode: PermissionMode.optional(),
    fastMode: z.boolean().optional(),
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
  | {
      type: 'rewind_preview';
      sessionId: string;
      messageId: string;
      canRewind: boolean;
      error?: string;
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
    }
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
  // A project key, "no-folder", or an absolute folder path inside the home folder.
  project: z.string(),
  text: z.string(),
  attachments: z.array(z.string()).max(10).optional(),
  model: z.string().optional(),
  effort: Effort.optional(),
  permissionMode: PermissionMode.optional(),
  fastMode: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;
export const CreateSessionResponse = z.object({ sessionId: z.string() });

export const CatalogResponse = z.object({
  commands: z.array(CommandInfo),
  models: z.array(ModelOption),
  defaults: LiveSettings,
});
export type CatalogResponse = z.infer<typeof CatalogResponse>;

// ---- Attachments ----
export const Upload = z.object({
  id: z.string(),
  kind: z.enum(['image', 'file']),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
});
export type Upload = z.infer<typeof Upload>;

// ---- File mentions and folders ----
export const FilesResponse = z.object({ files: z.array(z.string()), truncated: z.boolean() });
export const Folder = z.object({
  name: z.string(),
  path: z.string(),
  git: z.boolean(),
  // Chats the desktop has in this exact folder.
  chats: z.number(),
});
export type Folder = z.infer<typeof Folder>;
export const FoldersResponse = z.object({ path: z.string(), parent: z.string().optional(), folders: z.array(Folder) });
export type FoldersResponse = z.infer<typeof FoldersResponse>;

// ---- Desktop session presets (read-only) ----
export const Preset = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  model: z.string().optional(),
  effort: Effort.optional(),
  fastMode: z.boolean().optional(),
});
export type Preset = z.infer<typeof Preset>;
export const PresetsResponse = z.object({ presets: z.array(Preset) });

// ---- Chat actions ----
export const ForkRequest = z.object({
  upToMessageId: z.string().optional(),
  // Fork up to the entry before upToMessageId (to redo that message in the new chat).
  before: z.boolean().optional(),
});
export const SearchResponse = z.object({ matches: z.array(z.string()) });
export const ExportResponse = z.object({ title: z.string(), markdown: z.string() });
