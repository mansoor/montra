/** Application errors rendered as RFC 9457 problem details by ProblemFilter. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'forbidden', message);
export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unprocessable = (code: string, message: string) => new AppError(422, code, message);
