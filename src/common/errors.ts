export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  public constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ForbiddenError extends AppError {
  public constructor(message = "Forbidden") {
    super("FORBIDDEN", message, 403);
  }
}

export class NotFoundError extends AppError {
  public constructor(message = "Not found") {
    super("NOT_FOUND", message, 404);
  }
}

export class ValidationError extends AppError {
  public constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, 422, details);
  }
}
