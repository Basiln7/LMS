import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

/**
 * Error contract for the payment platform's retry logic:
 *
 *   200          applied (or duplicate of an applied event) — stop
 *   400 / 401    malformed or unauthenticated — fix the sender, do not retry
 *   409          event_id reused with a different payload — do not retry
 *   422          valid but not applicable yet (unknown course mapping, identity
 *                conflict) — retry after an admin fixes the data
 *   429 / 5xx    transient — retry with exponential backoff
 */

export class EventPayloadMismatchError extends ConflictException {
  constructor() {
    super({ error: 'EVENT_ID_REUSED', message: 'event_id was already received with a different payload' });
  }
}

export class UnknownCourseError extends UnprocessableEntityException {
  constructor(readonly courseIds: string[]) {
    super({ error: 'UNKNOWN_COURSE', message: 'No LMS course is mapped to these ids', course_ids: courseIds });
  }
}

export type IdentityConflictCode = 'EMAIL_LINKED_TO_ANOTHER_CUSTOMER' | 'PRIVILEGED_ACCOUNT_LINK_REFUSED';

export class IdentityConflictError extends UnprocessableEntityException {
  constructor(readonly code: IdentityConflictCode) {
    super({
      error: 'IDENTITY_CONFLICT',
      code,
      message: 'The student could not be matched safely to an LMS account; manual review required',
    });
  }
}
