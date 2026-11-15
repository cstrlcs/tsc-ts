export { twice } from './util.js';

export interface Shape {
  area(): number;
}

// An error of the referenced project, which a project that references it does not report.
export const broken: string = 1;
