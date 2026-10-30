// The switch for time slicing (./features/timeSlicing.ts), kept apart from the core: the core
// reads it only where @reactre/full-compat's builds compile slicing in, so @reactre/compat's
// builds, which never slice, leave this module out.

/** Whether transitions' renders yield every 5 ms; tests turn it on and off. */
export const slicing = { on: false };
