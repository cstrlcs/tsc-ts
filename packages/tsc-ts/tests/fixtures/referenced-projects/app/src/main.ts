import { twice, type Shape } from '../../lib/dist/index.js';
import { answer, type Id } from 'pkg';

export const doubled: string = twice(answer);
export const shape: Shape = { area: () => 1 };
export const id: Id = true;
