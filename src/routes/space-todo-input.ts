import * as v from 'valibot';
import { MAX_TODO_ATTACHMENTS, MAX_TODO_DESCRIPTION, MAX_TODO_REPOS, MAX_TODO_TITLE } from '../core/space-todos.ts';
import { AGENT_MODEL, RUN_ON } from './shared.ts';

const TITLE = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_TODO_TITLE));
const DESCRIPTION = v.pipe(v.string(), v.maxLength(MAX_TODO_DESCRIPTION));
const ATTACHMENTS = v.pipe(
	v.array(v.object({ name: v.pipe(v.string(), v.minLength(1), v.maxLength(300)), path: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)), kind: v.pipe(v.string(), v.maxLength(100)), size: v.number() })),
	v.maxLength(MAX_TODO_ATTACHMENTS),
);
/** Project repository ids; an empty list clears the tags. */
const REPOS = v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))), v.maxLength(MAX_TODO_REPOS));
const FIELDS = { description: v.optional(DESCRIPTION), attachments: v.optional(ATTACHMENTS), threadModel: v.optional(AGENT_MODEL), repos: v.optional(REPOS), runOn: v.optional(RUN_ON) };

export const CREATE_TODO = v.object({ ...FIELDS, title: TITLE });
export const EDIT_TODO = v.object({ ...FIELDS, title: v.optional(TITLE), status: v.optional(v.picklist(['open', 'done'])) });
