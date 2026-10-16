// The error every SDK call fails with.

export class PowlyError extends Error {
  status: number | undefined;
  /** For realtime calls (rooms): what went wrong, e.g. "full", "locked", "not_found". */
  code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "PowlyError";
    this.status = status;
    this.code = code;
  }
}
