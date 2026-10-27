/** An error whose message is safe to show; route handlers respond with its status. */
export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
