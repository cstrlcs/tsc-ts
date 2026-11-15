import { greeting, limit } from './app.box';
import './widget.vue';

export const length: number = greeting.length + limit;
export const wrong: string = limit;
