/** A rejected manufacturing write; routes respond with its HTTP status. */
export class ManufacturingWriteError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
