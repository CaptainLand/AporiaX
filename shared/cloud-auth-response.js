// A gateway authentication rejection before dispatch is safe to send again.
// A generic 401 can be emitted by a proxy after an inference was accepted.
export function isPreDispatchCloudAuthRejection(status, payload, requestId = null) {
  const error = payload?.error;
  return status === 401 && error?.type === 'auth_error' && (error.code || error.message) === 'UNAUTHORIZED' &&
    !requestId && !payload?.requestId && !payload?.request && !payload?.accountingPending && !payload?.billing && !payload?.usage;
}

export const cloudSupportsRequestDeduplication = payload => payload?.protocolVersion === 1 &&
  payload.modelGateway?.idempotency === 'reject-duplicate-no-replay';

// Trusted local observation; never attach secrets or ask the gateway to echo
// a flag that would authorize a client-side replay.
const observations = new WeakMap();
export function noteCloudAuthRecovery(response, observation) {
  observations.set(response, Object.freeze({ ...observation }));
  return response;
}
export const cloudAuthRecoveryFor = response => observations.get(response);
