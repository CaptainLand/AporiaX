// A gateway authentication rejection before dispatch is safe to send again.
// A generic 401 can be emitted by a proxy after an inference was accepted.
export function isPreDispatchCloudAuthRejection(status, payload, requestId = null) {
  const error = payload?.error;
  return status === 401 && error?.type === 'auth_error' && (error.code || error.message) === 'UNAUTHORIZED' &&
    !requestId && !payload?.requestId && !payload?.request && !payload?.accountingPending && !payload?.billing && !payload?.usage;
}
