import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string) {
    if (!value) return [];
    const trimmed = value.replace(/^\[/, "").replace(/\]$/, "");
    if (!trimmed) return [];
    return trimmed.split(",").map((n) => Number(n));
  },
});

export const userStatusEnum = pgEnum("user_status", [
  "pending_verification",
  "active",
  "suspended",
  "deleted",
]);

export const workspaceTypeEnum = pgEnum("workspace_type", [
  "personal",
  "organization",
]);

export const workspaceMemberRoleEnum = pgEnum("workspace_member_role", [
  "owner",
  "admin",
  "member",
  "viewer",
]);

export const whatsappIdentityStatusEnum = pgEnum("whatsapp_identity_status", [
  "unpaired",
  "pending_verification",
  "paired",
  "revoked",
]);

export const conversationStatusEnum = pgEnum("conversation_status", [
  "onboarding",
  "active",
  "paused",
  "closed",
]);

export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);

export const messageStatusEnum = pgEnum("message_status", [
  "received",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const documentStatusEnum = pgEnum("document_status", [
  "pending",
  "stored",
  "processing",
  "indexed",
  "failed",
]);

export const memoryStatusEnum = pgEnum("memory_status", [
  "active",
  "archived",
  "deleted",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "in_progress",
  "completed",
  "cancelled",
]);

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "scheduled",
  "completed",
  "cancelled",
]);

export const reminderStatusEnum = pgEnum("reminder_status", [
  "scheduled",
  "queued",
  "sent",
  "cancelled",
  "failed",
]);

export const alertOutboxStatusEnum = pgEnum("alert_outbox_status", [
  "pending",
  "processing",
  "delivered",
  "failed",
  "cancelled",
]);

export const agentJobStatusEnum = pgEnum("agent_job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "retry",
]);

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const toolCallStatusEnum = pgEnum("tool_call_status", [
  "pending",
  "allowed",
  "denied",
  "awaiting_confirmation",
  "succeeded",
  "failed",
]);

export const policyDecisionEnum = pgEnum("policy_decision", [
  "ALLOW",
  "DENY",
  "REQUIRE_CONFIRMATION",
]);

export const webhookEventStatusEnum = pgEnum("webhook_event_status", [
  "received",
  "processed",
  "ignored",
  "failed",
]);

export const integrationProviderEnum = pgEnum("integration_provider", [
  "open_finance",
  "google_calendar",
  "gmail",
  "google_drive",
  "moope_crm",
  "moope_frotas",
  "asaas",
  "other",
]);

export const integrationConnectionStatusEnum = pgEnum(
  "integration_connection_status",
  ["disconnected", "connecting", "connected", "error", "revoked"]
);

export const onboardingStepEnum = pgEnum("onboarding_step", [
  "awaiting_name",
  "awaiting_email",
  "awaiting_verification",
  "awaiting_usage_type",
  "awaiting_business_type",
  "awaiting_full_name",
  "awaiting_cpf",
  "awaiting_cep",
  "awaiting_terms",
  "completed",
]);

export const accountStatusEnum = pgEnum("account_status", [
  "active",
  "trial",
  "suspended",
  "cancelled",
]);

export const platformAdminRoleEnum = pgEnum("platform_admin_role", [
  "super_admin",
  "operator",
  "support",
]);

export const providerTestStatusEnum = pgEnum("provider_test_status", [
  "never",
  "connected",
  "invalid_credentials",
  "timeout",
  "provider_error",
  "not_configured",
]);

export const whatsappChannelPurposeEnum = pgEnum("whatsapp_channel_purpose", [
  "ASSISTANT",
  "OTHER",
]);

export const whatsappChannelStatusEnum = pgEnum("whatsapp_channel_status", [
  "online",
  "offline",
  "unknown",
  "disabled",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    globalUserId: uuid("global_user_id"),
    email: varchar("email", { length: 320 }).notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    name: varchar("name", { length: 200 }).notNull(),
    passwordHash: text("password_hash"),
    status: userStatusEnum("status").notNull().default("pending_verification"),
    timezone: varchar("timezone", { length: 64 })
      .notNull()
      .default("America/Sao_Paulo"),
    termsVersion: varchar("terms_version", { length: 64 }),
    privacyVersion: varchar("privacy_version", { length: 64 }),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
    accountStatus: accountStatusEnum("account_status").notNull().default("active"),
    cpfCnpj: varchar("cpf_cnpj", { length: 18 }),
    cep: varchar("cep", { length: 16 }),
    fullName: varchar("full_name", { length: 200 }),
    usageType: varchar("usage_type", { length: 32 }),
    businessType: varchar("business_type", { length: 64 }),
    profileJson: jsonb("profile_json").$type<Record<string, unknown>>().notNull().default({}),
    addressJson: jsonb("address_json").$type<Record<string, unknown>>().notNull().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_uidx").on(t.email),
    uniqueIndex("users_global_user_id_uidx")
      .on(t.globalUserId)
      .where(sql`${t.globalUserId} is not null`),
    index("users_status_idx").on(t.status),
  ]
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: workspaceTypeEnum("type").notNull().default("personal"),
    name: varchar("name", { length: 200 }).notNull(),
    timezone: varchar("timezone", { length: 64 })
      .notNull()
      .default("America/Sao_Paulo"),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("workspaces_owner_idx").on(t.ownerUserId),
    index("workspaces_type_idx").on(t.type),
  ]
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceMemberRoleEnum("role").notNull().default("member"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workspace_members_workspace_user_uidx").on(
      t.workspaceId,
      t.userId
    ),
    index("workspace_members_user_idx").on(t.userId),
  ]
);

export const whatsappChannels = pgTable(
  "whatsapp_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 32 }).notNull().default("zernio"),
    providerAccountId: varchar("provider_account_id", { length: 64 }).notNull(),
    providerNumberId: varchar("provider_number_id", { length: 64 }),
    phoneE164: varchar("phone_e164", { length: 32 }),
    displayName: varchar("display_name", { length: 200 }),
    status: whatsappChannelStatusEnum("status").notNull().default("unknown"),
    purpose: whatsappChannelPurposeEnum("purpose").notNull().default("OTHER"),
    isActive: boolean("is_active").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("whatsapp_channels_provider_account_uidx").on(
      t.provider,
      t.providerAccountId
    ),
    uniqueIndex("whatsapp_channels_one_assistant_uidx")
      .on(t.purpose)
      .where(sql`${t.purpose} = 'ASSISTANT' AND ${t.isActive} = true`),
  ]
);

export const whatsappIdentities = pgTable(
  "whatsapp_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    phoneE164: varchar("phone_e164", { length: 32 }),
    bsuid: varchar("bsuid", { length: 128 }),
    displayName: varchar("display_name", { length: 200 }),
    status: whatsappIdentityStatusEnum("status")
      .notNull()
      .default("unpaired"),
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    verificationCodeHash: text("verification_code_hash"),
    verificationExpiresAt: timestamp("verification_expires_at", {
      withTimezone: true,
    }),
    verificationAttempts: integer("verification_attempts").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("whatsapp_identities_phone_uidx")
      .on(t.phoneE164)
      .where(sql`${t.phoneE164} is not null and ${t.deletedAt} is null`),
    uniqueIndex("whatsapp_identities_bsuid_uidx")
      .on(t.bsuid)
      .where(sql`${t.bsuid} is not null and ${t.deletedAt} is null`),
    index("whatsapp_identities_user_idx").on(t.userId),
    index("whatsapp_identities_status_idx").on(t.status),
  ]
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    whatsappIdentityId: uuid("whatsapp_identity_id")
      .notNull()
      .references(() => whatsappIdentities.id, { onDelete: "restrict" }),
    whatsappChannelId: uuid("whatsapp_channel_id").references(
      () => whatsappChannels.id,
      { onDelete: "set null" }
    ),
    channel: varchar("channel", { length: 32 }).notNull().default("whatsapp"),
    externalConversationId: varchar("external_conversation_id", {
      length: 128,
    }),
    status: conversationStatusEnum("status").notNull().default("onboarding"),
    onboardingStep: onboardingStepEnum("onboarding_step")
      .notNull()
      .default("awaiting_name"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("conversations_workspace_idx").on(t.workspaceId),
    index("conversations_identity_idx").on(t.whatsappIdentityId),
    index("conversations_channel_idx").on(t.whatsappChannelId),
    uniqueIndex("conversations_external_uidx")
      .on(t.externalConversationId)
      .where(sql`${t.externalConversationId} is not null`),
  ]
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    direction: messageDirectionEnum("direction").notNull(),
    status: messageStatusEnum("status").notNull().default("received"),
    externalMessageId: varchar("external_message_id", { length: 128 }),
    bodyText: text("body_text"),
    contentType: varchar("content_type", { length: 64 })
      .notNull()
      .default("text"),
    mediaStorageKey: text("media_storage_key"),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    correlationId: varchar("correlation_id", { length: 64 }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId),
    index("messages_workspace_idx").on(t.workspaceId),
    uniqueIndex("messages_external_uidx")
      .on(t.externalMessageId)
      .where(sql`${t.externalMessageId} is not null`),
  ]
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    originalFilename: varchar("original_filename", { length: 512 }),
    mimeType: varchar("mime_type", { length: 128 }),
    sizeBytes: integer("size_bytes"),
    sha256: varchar("sha256", { length: 64 }),
    storageKey: text("storage_key").notNull(),
    source: varchar("source", { length: 64 }).notNull().default("whatsapp"),
    sourceType: varchar("source_type", { length: 64 }).default("whatsapp"),
    sourceId: uuid("source_id"),
    documentType: varchar("document_type", { length: 64 }),
    embeddingProvider: varchar("embedding_provider", { length: 64 }),
    embeddingDimensions: integer("embedding_dimensions"),
    status: documentStatusEnum("status").notNull().default("pending"),
    classification: varchar("classification", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("documents_workspace_idx").on(t.workspaceId),
    index("documents_sha256_idx").on(t.sha256),
    index("documents_status_idx").on(t.status),
  ]
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector1536("embedding"),
    embeddingModel: varchar("embedding_model", { length: 64 }).default(
      "text-embedding-3-small"
    ),
    embeddingProvider: varchar("embedding_provider", { length: 64 }),
    embeddingDimensions: integer("embedding_dimensions"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("document_chunks_workspace_idx").on(t.workspaceId),
    index("document_chunks_document_idx").on(t.documentId),
    uniqueIndex("document_chunks_doc_index_uidx").on(
      t.documentId,
      t.chunkIndex
    ),
  ]
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    type: varchar("type", { length: 64 }).notNull().default("note"),
    content: text("content").notNull(),
    sourceType: varchar("source_type", { length: 64 }).default("conversation"),
    sourceId: uuid("source_id"),
    embedding: vector1536("embedding"),
    embeddingModel: varchar("embedding_model", { length: 64 }).default(
      "text-embedding-3-small"
    ),
    embeddingProvider: varchar("embedding_provider", { length: 64 }),
    embeddingDimensions: integer("embedding_dimensions"),
    status: memoryStatusEnum("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("memories_workspace_idx").on(t.workspaceId),
    index("memories_status_idx").on(t.status),
    index("memories_workspace_type_idx").on(t.workspaceId, t.type),
  ]
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("open"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("tasks_workspace_idx").on(t.workspaceId),
    index("tasks_status_idx").on(t.status),
  ]
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    timezone: varchar("timezone", { length: 64 })
      .notNull()
      .default("America/Sao_Paulo"),
    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    location: varchar("location", { length: 500 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("appointments_workspace_idx").on(t.workspaceId),
    index("appointments_starts_at_idx").on(t.startsAt),
    index("appointments_user_idx").on(t.userId),
  ]
);

export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 500 }).notNull(),
    fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
    timezone: varchar("timezone", { length: 64 })
      .notNull()
      .default("America/Sao_Paulo"),
    status: reminderStatusEnum("status").notNull().default("scheduled"),
    deliveryChannel: varchar("delivery_channel", { length: 32 })
      .notNull()
      .default("whatsapp"),
    requiresTemplate: boolean("requires_template").notNull().default(false),
    templateName: varchar("template_name", { length: 128 }),
    recurrenceRule: varchar("recurrence_rule", { length: 256 }),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 128 }),
    occurrenceKey: varchar("occurrence_key", { length: 191 }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("reminders_workspace_idx").on(t.workspaceId),
    index("reminders_fire_at_status_idx").on(t.fireAt, t.status),
    index("reminders_user_idx").on(t.userId),
  ]
);

/** Outbox durável: cada ocorrência de alerta que DEVE ser entregue. */
export const alertOutbox = pgTable(
  "alert_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceId: uuid("source_id").notNull(),
    occurrenceKey: varchar("occurrence_key", { length: 191 }).notNull(),
    fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: alertOutboxStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(12),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveredMessageId: uuid("delivered_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    jobIdempotencyKey: varchar("job_idempotency_key", { length: 191 }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 128 }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("alert_outbox_occurrence_uidx").on(t.occurrenceKey),
    index("alert_outbox_due_idx").on(t.status, t.nextAttemptAt, t.fireAt),
    index("alert_outbox_workspace_idx").on(t.workspaceId, t.status),
    index("alert_outbox_source_idx").on(t.sourceType, t.sourceId),
  ]
);

export const agentJobs = pgTable(
  "agent_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    webhookEventId: uuid("webhook_event_id"),
    jobType: varchar("job_type", { length: 64 }).notNull(),
    status: agentJobStatusEnum("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 128 }),
    lastError: text("last_error"),
    idempotencyKey: varchar("idempotency_key", { length: 191 }),
    correlationId: varchar("correlation_id", { length: 64 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deadAt: timestamp("dead_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("agent_jobs_idempotency_uidx")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("agent_jobs_poll_idx").on(t.status, t.availableAt),
    index("agent_jobs_workspace_idx").on(t.workspaceId),
  ]
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => agentJobs.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    status: agentRunStatusEnum("status").notNull().default("running"),
    provider: varchar("provider", { length: 64 }),
    model: varchar("model", { length: 128 }),
    inputSummary: text("input_summary"),
    outputSummary: text("output_summary"),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    toolCount: integer("tool_count").notNull().default(0),
    correlationId: varchar("correlation_id", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    ...timestamps,
  },
  (t) => [
    index("agent_runs_job_idx").on(t.jobId),
    index("agent_runs_workspace_idx").on(t.workspaceId),
  ]
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    toolName: varchar("tool_name", { length: 128 }).notNull(),
    policyDecision: policyDecisionEnum("policy_decision").notNull(),
    status: toolCallStatusEnum("status").notNull().default("pending"),
    args: jsonb("args").$type<Record<string, unknown>>().default({}),
    resultSummary: text("result_summary"),
    error: text("error"),
    errorCode: varchar("error_code", { length: 64 }),
    executionKey: varchar("execution_key", { length: 191 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    correlationId: varchar("correlation_id", { length: 64 }),
    ...timestamps,
  },
  (t) => [
    index("tool_calls_run_idx").on(t.agentRunId),
    index("tool_calls_workspace_idx").on(t.workspaceId),
    index("tool_calls_tool_name_idx").on(t.toolName),
    uniqueIndex("tool_calls_execution_key_uidx")
      .on(t.executionKey)
      .where(sql`${t.executionKey} is not null`),
  ]
);

export const consentAcceptances = pgTable(
  "consent_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    termsVersion: varchar("terms_version", { length: 64 }).notNull(),
    privacyVersion: varchar("privacy_version", { length: 64 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull().default("whatsapp"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("consent_acceptances_user_idx").on(t.userId)]
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 64 }).notNull().default("zernio"),
    externalEventId: varchar("external_event_id", { length: 191 }).notNull(),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    status: webhookEventStatusEnum("status").notNull().default("received"),
    signatureValid: boolean("signature_valid").notNull().default(false),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    headers: jsonb("headers").$type<Record<string, unknown>>().default({}),
    correlationId: varchar("correlation_id", { length: 64 }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("webhook_events_provider_external_uidx").on(
      t.provider,
      t.externalEventId
    ),
    index("webhook_events_type_idx").on(t.eventType),
  ]
);

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: integrationProviderEnum("provider").notNull(),
    status: integrationConnectionStatusEnum("status")
      .notNull()
      .default("disconnected"),
    displayName: varchar("display_name", { length: 200 }),
    // Encrypted blob / vault reference — never passed to LLM prompts.
    credentialsRef: text("credentials_ref"),
    secretReference: text("secret_reference"),
    scopes: jsonb("scopes").$type<string[]>().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    consentExpiresAt: timestamp("consent_expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("integration_connections_workspace_provider_uidx").on(
      t.workspaceId,
      t.provider
    ),
    index("integration_connections_status_idx").on(t.status),
  ]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 128 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }),
    resourceId: uuid("resource_id"),
    correlationId: varchar("correlation_id", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_workspace_idx").on(t.workspaceId),
    index("audit_logs_action_idx").on(t.action),
  ]
);

export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: platformAdminRoleEnum("role").notNull().default("operator"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("platform_admins_user_uidx")
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
  ]
);

export const encryptedSecrets = pgTable(
  "encrypted_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 128 }).notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("encrypted_secrets_key_uidx").on(t.key)]
);

export const platformSettings = pgTable(
  "platform_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespace: varchar("namespace", { length: 64 }).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    valueJson: jsonb("value_json").$type<Record<string, unknown>>().notNull().default({}),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("platform_settings_ns_key_uidx").on(t.namespace, t.key),
  ]
);

export const providerConfigs = pgTable(
  "provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerKey: varchar("provider_key", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    providerName: varchar("provider_name", { length: 64 }).notNull(),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    secretRefs: jsonb("secret_refs").$type<Record<string, string>>().notNull().default({}),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastTestStatus: providerTestStatusEnum("last_test_status")
      .notNull()
      .default("never"),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [uniqueIndex("provider_configs_key_uidx").on(t.providerKey)]
);

export const whatsappTemplates = pgTable(
  "whatsapp_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    logicalName: varchar("logical_name", { length: 64 }).notNull(),
    providerTemplateName: varchar("provider_template_name", { length: 128 }).notNull(),
    language: varchar("language", { length: 16 }).notNull().default("pt_BR"),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex("whatsapp_templates_logical_uidx").on(t.logicalName)]
);

export const processHeartbeats = pgTable("process_heartbeats", {
  processName: varchar("process_name", { length: 64 }).primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 128 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }),
    resourceId: varchar("resource_id", { length: 128 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("admin_audit_logs_actor_idx").on(t.actorUserId),
    index("admin_audit_logs_action_idx").on(t.action),
  ]
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    limitsJson: jsonb("limits_json").$type<Record<string, unknown>>().notNull().default({}),
    featuresJson: jsonb("features_json").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex("plans_code_uidx").on(t.code)]
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    provider: varchar("provider", { length: 64 }).notNull().default("manual"),
    externalSubscriptionId: varchar("external_subscription_id", { length: 191 }),
    ...timestamps,
  },
  (t) => [index("subscriptions_workspace_idx").on(t.workspaceId)]
);

export const usageCounters = pgTable(
  "usage_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    periodKey: varchar("period_key", { length: 16 }).notNull(),
    metric: varchar("metric", { length: 64 }).notNull(),
    value: integer("value").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_counters_ws_period_metric_uidx").on(
      t.workspaceId,
      t.periodKey,
      t.metric
    ),
  ]
);

/** Telefones com acesso livre (homolog / VIP — sem cobrança / sem “em dia”). */
export const clientAccessWhitelist = pgTable(
  "client_access_whitelist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneE164: varchar("phone_e164", { length: 32 }).notNull(),
    phoneDigits: varchar("phone_digits", { length: 32 }).notNull(),
    label: varchar("label", { length: 200 }),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("client_access_whitelist_digits_uidx")
      .on(t.phoneDigits)
      .where(sql`${t.deletedAt} is null`),
    index("client_access_whitelist_phone_idx").on(t.phoneE164),
  ]
);

/** Telefones banidos (sem resposta do Assessor). Regras avançadas depois. */
export const clientAccessBlacklist = pgTable(
  "client_access_blacklist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneE164: varchar("phone_e164", { length: 32 }).notNull(),
    phoneDigits: varchar("phone_digits", { length: 32 }).notNull(),
    reason: varchar("reason", { length: 500 }),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("client_access_blacklist_digits_uidx")
      .on(t.phoneDigits)
      .where(sql`${t.deletedAt} is null`),
    index("client_access_blacklist_phone_idx").on(t.phoneE164),
  ]
);

/**
 * Contexto empresarial ativo por WhatsApp (locadora / Facejus).
 * Pessoal NÃO entra aqui — sempre disponível em paralelo.
 */
export const whatsappBusinessContext = pgTable(
  "whatsapp_business_context",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneDigits: varchar("phone_digits", { length: 32 }).notNull(),
    phoneE164: varchar("phone_e164", { length: 32 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    tenantId: integer("tenant_id").notNull(),
    label: varchar("label", { length: 200 }).notNull(),
    papel: varchar("papel", { length: 64 }),
    metaJson: jsonb("meta_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("whatsapp_business_context_phone_uidx").on(t.phoneDigits),
    index("whatsapp_business_context_kind_idx").on(t.kind),
  ]
);

/** Base de conhecimento da plataforma MOOPE (RAG institucional). */
export const platformKnowledge = pgTable(
  "platform_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 128 }).notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    category: varchar("category", { length: 64 }).notNull().default("geral"),
    content: text("content").notNull(),
    sourceUrl: varchar("source_url", { length: 500 }),
    embedding: vector1536("embedding"),
    embeddingModel: varchar("embedding_model", { length: 64 }).default(
      "text-embedding-3-small"
    ),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("platform_knowledge_slug_uidx").on(t.slug),
    index("platform_knowledge_category_idx").on(t.category),
    index("platform_knowledge_status_idx").on(t.status),
  ]
);

/** Página visual aberta pelo WhatsApp (token, expira). */
export const visualBoards = pgTable(
  "visual_boards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: varchar("token", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("visual_boards_token_uidx").on(t.token),
    index("visual_boards_expires_idx").on(t.expiresAt),
  ]
);

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WhatsappIdentity = typeof whatsappIdentities.$inferSelect;
export type WhatsappChannel = typeof whatsappChannels.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentJob = typeof agentJobs.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type ClientAccessWhitelist = typeof clientAccessWhitelist.$inferSelect;
export type ClientAccessBlacklist = typeof clientAccessBlacklist.$inferSelect;
export type WhatsappBusinessContext =
  typeof whatsappBusinessContext.$inferSelect;
export type PlatformKnowledge = typeof platformKnowledge.$inferSelect;
