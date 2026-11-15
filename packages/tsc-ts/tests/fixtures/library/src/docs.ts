/**
 * Adds numbers.
 * @param a The first number.
 * @param b The second number.
 * @returns The sum.
 * @deprecated Use `join`.
 */
export function add(a: number, b: number): number {
  return a + b;
}

/**
 * @overload
 * @param value A string.
 */
/**
 * Joins values.
 * @param value The value.
 * @param rest More values.
 */
export function join(value: string, ...rest: string[]): string {
  return [value, ...rest].join(',');
}

/** @deprecated Use `join`. */
export function concat(a: string): string;
/** Concatenates. @param a The first. @param b The second. */
export function concat(a: string, b: string): string;
export function concat(a: string, b?: string): string {
  return a + (b ?? '');
}

/**
 * Picks a property.
 * @template T The object type.
 * @template K The key type.
 * @param options The options.
 * @param options.object The object.
 * @param pair The fallback pair.
 */
export function pick<T, K extends keyof T>({ object, key }: { object: T; key: K }, [first, second]: [T[K], T[K]]): T[K] {
  return object[key] ?? first ?? second;
}

/** The answer. @since 1.0 */
export const answer = 42,
  /** The other. @internal */
  other = 1;

/** A callback. @see add */
export const callback = /** @param x The input. @returns Twice the input. */ (x: number) => x * 2;

/** A shape. @abstract */
export class Shape {
  /** The sides. @readonly */
  sides = 4;
  /** The scale. @default 1 */
  static scale: number = /** @type {number} */ (1);
  /**
   * Creates a shape.
   * @param sides The number of sides.
   */
  constructor(sides?: number) {
    if (sides !== undefined) this.sides = sides;
  }
  /** The area. @returns The area. @throws {RangeError} When negative. */
  area(/** The unit. @default 1 */ unit = 1): number {
    /** A local. @private */
    const local = this.sides * unit;
    return /** @type {number} */ (local);
  }
}

/** Options. @public */
export interface Options {
  /** The width. @default 1 */
  width?: number;
  /** Draws. @param x The position. */
  draw(x: number): void;
}

/** Defaults. @satisfies {Options} */
export const defaults = {
  /** The default width. @deprecated */
  width: 1,
  /** @param x The position. */
  draw: (x: number) => void x,
} satisfies Options;

/** A colour. @enum */
export enum Colour {
  /** Red. @deprecated Use Green. */
  Red,
  Green,
}

/** A namespace. @namespace */
export namespace Nested {
  /** Inner. @param value The value. */
  export function inner(value: string): string {
    /** Innermost. @returns Nothing. */
    function innermost(): void {}
    innermost();
    return value;
  }
}

/** A statement. @todo Remove it. */
add(answer, other);

/** The default. @example import add from './docs.js'; */
export default add;
