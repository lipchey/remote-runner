/* Failure text only ever reaches an operator's stderr or the doctor report through this class, so
   that the rule stays checkable at the throw site: a message may be raised as diagnosable only when
   it is authored here and carries no external text. Anything interpolating remote output, provider
   output, or a native error (`unsupported Linux architecture: ${machine}`) stays a plain Error and
   is reported by its stable reason alone. */
export class DiagnosableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiagnosableError";
  }
}

export function diagnosableMessage(caught: unknown): string | undefined {
  return caught instanceof DiagnosableError ? caught.message : undefined;
}
