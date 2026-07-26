/** Error raised when a request fails or comes back in a shape we did not expect. */
export class DearApiError extends Error {
  readonly status: number | undefined

  /**
   * Creates an API error, keeping the HTTP status when there was one.
   *
   * @param message - what went wrong, in a form safe to log
   * @param status - HTTP status code, when the failure came from a response
   * @param options - standard Error options, used here to keep the original cause
   */
  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DearApiError'
    this.status = status
  }
}
