import { createCn } from 'cn/config';

/** The type steps and radius steps of the design system (`styles.css` `@theme`), so a size and a colour, or two radii, merge as Tailwind's own do. */
export const TEXT_STEPS = ['nano', 'micro', 'small', 'body', 'body-lg', 'h3', 'h2', 'h1', 'display'];
export const RADIUS_STEPS = ['mark', 'inner', 'control', 'tile', 'card', 'dialog'];

export const cn = createCn({
	extend: {
		theme: { radius: RADIUS_STEPS },
		classGroups: { 'font-size': [{ text: TEXT_STEPS }] },
	},
});
