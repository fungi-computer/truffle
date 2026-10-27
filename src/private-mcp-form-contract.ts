import {
  ExtensionId,
  type CommandsV0,
} from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import {
  ApprovalAnswerInputSchema,
  ApprovalDenialNoteSchema,
  ApprovalRefusalSchema,
  ApprovalViewSchema,
} from "@fungi.computer/approvals";

/** The actual MCP form, not a ledger record or an authorization decision. */
export const McpFormApprovalRequestSchema = Schema.Struct({
  message: Schema.String,
  requestedSchema: Schema.Struct({
    type: Schema.Literal("object"),
    properties: Schema.Struct({
      approve: Schema.Struct({
        type: Schema.Literal("boolean"),
        title: Schema.optionalKey(Schema.String),
      }),
    }),
    required: Schema.Tuple([Schema.Literal("approve")]),
  }),
});

export type McpFormApprovalRequest = typeof McpFormApprovalRequestSchema.Type;
/** Human dispositions of one live protocol request. */
export type McpFormApprovalDecision = "approve" | "decline" | "cancel";

const answerResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("answered"),
    view: ApprovalViewSchema,
  }),
  ApprovalRefusalSchema,
  // The attached client awaits the private host's post-commit decision.
  Schema.Struct({ kind: Schema.Literal("submitted") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["not-attached", "not-pending"]),
  }),
]);
export type McpFormAnswerResult = typeof answerResult.Type;

/** The ephemeral id references the canonical record; it grants no authority. */
const McpFormPendingSchema = Schema.Struct({
  id: Schema.String,
  approval: ApprovalViewSchema,
  review: Schema.optionalKey(
    Schema.Struct({
      command: Schema.String,
      cwd: Schema.String,
      justification: Schema.String,
      form: Schema.Literals(["direct", "shell"]),
      kind: Schema.Literals(["exec", "extension-install"]),
      argv: Schema.optionalKey(Schema.Array(Schema.String)),
      prefix: Schema.optionalKey(Schema.Array(Schema.String)),
      warning: Schema.optionalKey(Schema.String),
      alwaysAllowCoverage: Schema.optionalKey(Schema.String),
      alwaysAllowUnavailableReason: Schema.optionalKey(Schema.String),
      risk: Schema.optionalKey(
        Schema.Struct({ summary: Schema.String, detail: Schema.String }),
      ),
    }),
  ),
});

/** The existing Session extension slot carries only display-safe form data. */
export const mcpFormApprovalContract = {
  id: ExtensionId.make("botanical-local-mcp-form"),
  commands: {
    answer: {
      scope: "session",
      input: Schema.Struct({
        id: Schema.String,
        decision: Schema.Literals(["approve", "deny", "always-allow"]),
        expectedRevision: ApprovalAnswerInputSchema.fields.expectedRevision,
        denialNote: Schema.optionalKey(ApprovalDenialNoteSchema),
      }),
      output: answerResult,
    },
  } satisfies CommandsV0,
  projection: {
    schema: Schema.Struct({ pending: Schema.Array(McpFormPendingSchema) }),
  },
};
