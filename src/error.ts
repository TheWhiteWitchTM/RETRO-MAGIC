/** A mistake in a retro source file. `line` and `column` start at 1. */
export class RetroError extends Error {
  readonly line: number;
  readonly column: number;
  readonly filename: string;

  constructor(message: string, line = 1, column = 1, filename = '') {
    super(message);
    this.name = 'RetroError';
    this.line = line;
    this.column = column;
    this.filename = filename;
  }

  /** `file:line:column message`, ready for a terminal or the IDE. */
  format(): string {
    const where = this.filename
      ? `${this.filename}:${this.line}:${this.column}`
      : `${this.line}:${this.column}`;
    return `${where} ${this.message}`;
  }
}

export interface Diagnostic {
  line: number;
  column: number;
  message: string;
  filename: string;
}

export function diagnostic(error: RetroError): Diagnostic {
  return {
    line: error.line,
    column: error.column,
    message: error.message,
    filename: error.filename,
  };
}
