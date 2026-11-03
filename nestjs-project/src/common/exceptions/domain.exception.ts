export abstract class DomainException extends Error {
  // Extra response headers the exception filter must send (e.g. Content-Range on 416).
  public responseHeaders?: Record<string, string>;

  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      400,
      'Upload parts are invalid or out of order',
    );
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found for this user');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class UploadNotInProgressException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_IN_PROGRESS', 409, 'Upload is not in progress');
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      422,
      'Uploaded file size exceeds the declared size',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}

export class RangeNotSatisfiableException extends DomainException {
  constructor(totalBytes: number) {
    super('RANGE_NOT_SATISFIABLE', 416, 'Requested range is not satisfiable');
    this.responseHeaders = { 'Content-Range': `bytes */${totalBytes}` };
  }
}

export class InvalidPartNumbersException extends DomainException {
  constructor() {
    super('VALIDATION_ERROR', 400, 'Part numbers are outside the upload range');
  }
}
