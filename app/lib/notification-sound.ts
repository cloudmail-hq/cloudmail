// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The new-mail tone.
 *
 * Synthesised with WebAudio rather than shipped as an audio file. An asset would
 * be one more request on a path nobody is waiting for, would have to be decoded
 * before it could play, and would need a licence trail for two notes. Two
 * oscillators cost nothing and are exact.
 *
 * A single `AudioContext` is reused across calls: browsers cap how many a document
 * may create, and a burst of arrivals would otherwise leak one per notification
 * until playback stopped working entirely.
 */

/** Reused across calls. Created lazily so nothing is allocated until it sounds. */
let context: AudioContext | null = null;

type AudioContextConstructor = new () => AudioContext;

function audioContext(): AudioContext | null {
	if (context && context.state !== "closed") return context;
	if (typeof window === "undefined") return null;

	// `webkitAudioContext` is still the only constructor on older iOS Safari.
	const Ctor = (window.AudioContext ??
		(window as unknown as { webkitAudioContext?: AudioContextConstructor })
			.webkitAudioContext) as AudioContextConstructor | undefined;
	if (!Ctor) return null;

	try {
		context = new Ctor();
		return context;
	} catch {
		// Autoplay policy can refuse construction outright. A silent notification
		// is a far better outcome than a thrown error inside a polling loop.
		return null;
	}
}

/** The two notes, as [frequency in Hz, offset in seconds]. A rising minor third. */
const NOTES: [number, number][] = [
	[880, 0],
	[1174.66, 0.09],
];

/** How long each note rings. Short enough not to overlap the next arrival. */
const NOTE_DURATION_S = 0.16;

/**
 * Peak gain.
 *
 * Deliberately quiet: this fires while the reader is doing something else, and a
 * notification tone that startles is a preference people turn off once and never
 * turn on again.
 */
const PEAK_GAIN = 0.07;

/**
 * Play the tone.
 *
 * Resolves once the notes are scheduled, not once they finish — the caller is a
 * poll loop or a click handler and has nothing to do with the tail.
 *
 * Every failure is swallowed. This is decoration on top of a notification, and
 * an audio device that will not open must not take the notification with it.
 */
export async function playNewMailChime(): Promise<void> {
	const ctx = audioContext();
	if (!ctx) return;

	try {
		// A context created before any user gesture starts suspended, and a
		// suspended context schedules silently. Resuming is a no-op when running.
		if (ctx.state === "suspended") await ctx.resume();
		if (ctx.state !== "running") return;

		const start = ctx.currentTime;

		for (const [frequency, offset] of NOTES) {
			const oscillator = ctx.createOscillator();
			const gain = ctx.createGain();

			// Sine, because a square or saw wave at these frequencies reads as an
			// error buzzer rather than a notification.
			oscillator.type = "sine";
			oscillator.frequency.value = frequency;

			const noteStart = start + offset;
			const noteEnd = noteStart + NOTE_DURATION_S;

			// Ramped rather than switched on: an abrupt gain change puts a click at
			// each edge, which is audible and sounds like a fault.
			gain.gain.setValueAtTime(0, noteStart);
			gain.gain.linearRampToValueAtTime(PEAK_GAIN, noteStart + 0.012);
			gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

			oscillator.connect(gain);
			gain.connect(ctx.destination);

			oscillator.start(noteStart);
			// Stopping releases the node; without it each call would leave a live
			// oscillator attached to the shared context forever.
			oscillator.stop(noteEnd + 0.02);
		}
	} catch {
		// Nothing to report: the notification itself already told the reader.
	}
}
