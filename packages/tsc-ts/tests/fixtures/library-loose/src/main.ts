// Without strictNullChecks, the null and undefined in the type of an expression widen to any.
export const loose = { none: null, missing: undefined, list: [null, undefined], nested: { none: null }, kept: 1 };
export let unset = undefined;
export const either = Math.random() > 0.5 ? { none: null } : { text: 'a' };
