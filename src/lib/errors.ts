export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class InvalidApiKeyError extends AppError {
  constructor() {
    super(401, 'INVALID_API_KEY', 'Invalid or missing API key')
  }
}

export class InvalidProfileError extends AppError {
  constructor(message: string) {
    super(422, 'INVALID_PROFILE', message)
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded')
  }
}
