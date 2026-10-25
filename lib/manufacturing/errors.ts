import { HttpError } from "../http-error.ts";

/** A rejected manufacturing write; routes respond with its HTTP status. */
export class ManufacturingWriteError extends HttpError {}
