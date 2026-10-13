/** The part of noVNC's RFB client the Computer panel uses; the package ships no types. */
declare module '@novnc/novnc' {
	export default class RFB extends EventTarget {
		constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; wsProtocols?: string[] });
		viewOnly: boolean;
		scaleViewport: boolean;
		resizeSession: boolean;
		clipViewport: boolean;
		focusOnClick: boolean;
		background: string;
		qualityLevel: number;
		compressionLevel: number;
		disconnect(): void;
		focus(): void;
		blur(): void;
	}
}
