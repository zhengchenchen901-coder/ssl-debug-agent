import { createHash, randomUUID } from "node:crypto";

export const APPROVED_COMMAND_CONFIRMATION = "使用命令";
export const DEFAULT_APPROVED_COMMAND_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_APPROVED_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_APPROVED_COMMAND_TIMEOUT_MS = 300_000;
export const MAX_APPROVED_COMMAND_LENGTH = 16 * 1024;
export const MAX_APPROVED_COMMANDS = 20;

export class ApprovedCommandError extends Error {
  constructor(message, code = "APPROVED_COMMAND_REJECTED", statusCode = 400) {
    super(message);
    this.name = "ApprovedCommandError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function hashCommands(commands) {
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex");
}

export function redactCommand(command, maxChars = 512) {
  if (typeof command !== "string" || command.length === 0) {
    return "";
  }

  let redacted = command
    .replace(
      /(--(?:password|pass|pwd)(?:=|\s+))("[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:MONGO|MYSQL|PG|POSTGRES|REDIS)?_?PASSWORD=)("[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(mongodb(?:\+srv)?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
      "$1[REDACTED]$3",
    );

  if (redacted.length <= maxChars) {
    return redacted;
  }

  return `${redacted.slice(0, maxChars)}\n...[truncated ${redacted.length - maxChars} chars]`;
}

export function normalizeApprovedCommandTimeoutMs(value, settings) {
  const defaultTimeoutMs = settings.defaultTimeoutMs || DEFAULT_APPROVED_COMMAND_TIMEOUT_MS;
  const maxTimeoutMs = settings.maxTimeoutMs || MAX_APPROVED_COMMAND_TIMEOUT_MS;

  if (value === undefined || value === null) {
    return Math.min(defaultTimeoutMs, maxTimeoutMs);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApprovedCommandError(
      "timeoutMs must be a positive integer",
      "INVALID_APPROVED_COMMAND_TIMEOUT",
    );
  }

  return Math.min(parsed, maxTimeoutMs);
}

export function assertApprovedCommandsEnabled(config) {
  if (!config.approvedCommands?.enabled) {
    throw new ApprovedCommandError(
      "approved command execution is disabled; set REMOTE_DEBUG_APPROVED_COMMANDS=1 to enable it",
      "APPROVED_COMMANDS_DISABLED",
      403,
    );
  }
}

function normalizePurpose(value) {
  if (value === undefined || value === null || value === "") {
    return "未说明";
  }

  if (typeof value !== "string") {
    throw new ApprovedCommandError("purpose must be a string", "INVALID_APPROVED_COMMAND_PURPOSE");
  }

  return value.trim().slice(0, 500) || "未说明";
}

function normalizeCommands(value, settings) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApprovedCommandError(
      "commands must be a non-empty array",
      "INVALID_APPROVED_COMMANDS",
    );
  }

  const maxCommands = settings.maxCommands || MAX_APPROVED_COMMANDS;
  const maxCommandLength = settings.maxCommandLength || MAX_APPROVED_COMMAND_LENGTH;
  if (value.length > maxCommands) {
    throw new ApprovedCommandError(
      `commands cannot contain more than ${maxCommands} items`,
      "TOO_MANY_APPROVED_COMMANDS",
    );
  }

  return value.map((command, index) => {
    if (typeof command !== "string") {
      throw new ApprovedCommandError(
        `command at index ${index} must be a string`,
        "INVALID_APPROVED_COMMAND",
      );
    }

    const normalized = command.trim();
    if (!normalized) {
      throw new ApprovedCommandError(
        `command at index ${index} must be non-empty`,
        "INVALID_APPROVED_COMMAND",
      );
    }

    if (normalized.includes("\0")) {
      throw new ApprovedCommandError(
        `command at index ${index} contains a null byte`,
        "INVALID_APPROVED_COMMAND",
      );
    }

    if (normalized.length > maxCommandLength) {
      throw new ApprovedCommandError(
        `command at index ${index} is longer than ${maxCommandLength} characters`,
        "APPROVED_COMMAND_TOO_LONG",
      );
    }

    return normalized;
  });
}

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function publicDraft(draft) {
  return {
    draftId: draft.draftId,
    purpose: draft.purpose,
    commands: draft.commands.slice(),
    commandHash: draft.commandHash,
    commandCount: draft.commands.length,
    commandBlock: draft.commands.join("\n\n"),
    status: draft.status,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    executedAt: draft.executedAt,
    instructions: [
      "选择“只生成命令，不执行”：不要调用执行工具，直接把命令交给人工执行。",
      "选择“使用命令”：调用 remote_debug_execute_command_draft，并传入 draftId、commandHash 和确认短语“使用命令”。",
    ],
  };
}

export function createCommandDraftStore(options = {}) {
  const now = options.now || (() => Date.now());
  const drafts = new Map();

  function cleanup(nowMs = now()) {
    for (const [draftId, draft] of drafts.entries()) {
      if (draft.expiresAtMs <= nowMs && draft.status === "pending") {
        drafts.delete(draftId);
      }
    }
  }

  function createDraft({ purpose, commands, settings }) {
    const nowMs = now();
    cleanup(nowMs);
    const normalizedCommands = normalizeCommands(commands, settings);
    const ttlMs = settings.ttlMs || DEFAULT_APPROVED_COMMAND_TTL_MS;
    const draft = {
      draftId: randomUUID(),
      purpose: normalizePurpose(purpose),
      commands: normalizedCommands,
      commandHash: hashCommands(normalizedCommands),
      createdAt: nowIso(nowMs),
      expiresAt: nowIso(nowMs + ttlMs),
      expiresAtMs: nowMs + ttlMs,
      executedAt: undefined,
      status: "pending",
    };

    drafts.set(draft.draftId, draft);
    return publicDraft(draft);
  }

  function getDraft(draftId) {
    cleanup();
    const draft = drafts.get(draftId);
    if (!draft) {
      throw new ApprovedCommandError(
        "approved command draft was not found",
        "APPROVED_COMMAND_DRAFT_NOT_FOUND",
        404,
      );
    }

    return publicDraft(draft);
  }

  function claimDraft({ draftId, commandHash, confirmation }) {
    const draft = drafts.get(draftId);
    if (!draft) {
      throw new ApprovedCommandError(
        "approved command draft was not found",
        "APPROVED_COMMAND_DRAFT_NOT_FOUND",
        404,
      );
    }

    if (draft.expiresAtMs <= now()) {
      drafts.delete(draftId);
      throw new ApprovedCommandError(
        "approved command draft has expired",
        "APPROVED_COMMAND_DRAFT_EXPIRED",
        409,
      );
    }

    if (draft.status !== "pending") {
      throw new ApprovedCommandError(
        "approved command draft has already been used",
        "APPROVED_COMMAND_DRAFT_ALREADY_USED",
        409,
      );
    }

    if (commandHash !== draft.commandHash) {
      throw new ApprovedCommandError(
        "approved command hash does not match the draft",
        "APPROVED_COMMAND_HASH_MISMATCH",
      );
    }

    if (confirmation !== APPROVED_COMMAND_CONFIRMATION) {
      throw new ApprovedCommandError(
        `confirmation must exactly equal ${APPROVED_COMMAND_CONFIRMATION}`,
        "APPROVED_COMMAND_CONFIRMATION_REQUIRED",
      );
    }

    draft.status = "executing";
    return publicDraft(draft);
  }

  function finishDraft(draftId, status = "executed") {
    const draft = drafts.get(draftId);
    if (!draft) {
      return undefined;
    }

    draft.status = status;
    draft.executedAt = nowIso(now());
    return publicDraft(draft);
  }

  return {
    claimDraft,
    createDraft,
    finishDraft,
    getDraft,
  };
}
