/**
 * Injection token for the rating cutoffs spec representation is counted at.
 *
 * Provided with `REPRESENTATION_MIN_RATINGS` from `@denipetrov/spirit-link/constants`,
 * the list the backend and front end use too, so the cutoffs written here are
 * the ones they ask for. A token rather than a direct import only so a test can
 * count at cutoffs of its own (a cutoff of 0 counts every row); nothing in the
 * application provides anything else.
 */
export const REPRESENTATION_CUTOFFS = Symbol('REPRESENTATION_CUTOFFS');
