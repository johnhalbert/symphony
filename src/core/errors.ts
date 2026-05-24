export type SymphonyErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error"
  | "config_validation_error"
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "workspace_error"
  | "hook_error"
  | "lifecycle_store_corrupt"
  | "tracker_error"
  | "tracker_unavailable"
  | "agent_error"
  | "not_found"
  | "conflict"
  | "invalid_request";

export class SymphonyError extends Error {
  readonly code: SymphonyErrorCode;
  readonly details: unknown;

  constructor(code: SymphonyErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "SymphonyError";
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
