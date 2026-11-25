/**
 * Shared JSDoc type definitions for StreamGrid client modules.
 *
 * @typedef {Object} AppState
 * @property {string} [clientId]
 * @property {string} [currentUserName]
 * @property {string} [roomId]
 * @property {{ roomId: string, password: string, userName: string, inFlight: boolean } | null} [pendingRoomJoin]
 * @property {string} [myId]
 * @property {MediaStream | null} [localStream]
 * @property {string} [currentRoomPassword]
 * @property {{ resolution: string, fps: number } | null} [activeStreamMaxQuality]
 * @property {'1080p' | '720p' | string} [selectedVideoResolution]
 * @property {number} [selectedVideoFps]
 * @property {string | null} [selectedAudioSource]
 * @property {boolean} [excludeSelectedApp]
 *
 * @typedef {Record<string, any>} DomRefs
 * @typedef {(message: string, type?: string, durationMs?: number) => void} ShowToastFn
 * @typedef {(type?: string) => void} PlayPresenceChimeFn
 * @typedef {Window & typeof globalThis & Record<string, any>} AnyWindow
 * @typedef {Document & Record<string, any>} AnyDocument
 */
export {};
