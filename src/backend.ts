/** The narrow API the lobby uses to wake and observe the Paper backend. */
export type BackendState = "ready" | "starting" | "stopped" | "unavailable";

export interface BackendEnv {
	/** HTTPS endpoint of the Oracle wake gateway. Kept secret-free so it may be a Worker var. */
	WAKE_URL?: string;
	/** Worker secret: bearer token accepted by the Oracle wake gateway. */
	WAKE_TOKEN?: string;
}

export interface BackendStatus {
	state: BackendState;
	retryAfterMs?: number;
}

/**
 * Request a backend start and return its current readiness.  The endpoint is
 * deliberately idempotent: several people pressing Join must never cause
 * several Paper restarts.
 */
export async function wakeBackend(env: BackendEnv): Promise<BackendStatus> {
	if (!env.WAKE_URL || !env.WAKE_TOKEN) return { state: "unavailable" };
	try {
		const response = await fetch(env.WAKE_URL, {
			method: "POST",
			headers: { authorization: `Bearer ${env.WAKE_TOKEN}`, "content-type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) return { state: "unavailable" };
		const body = (await response.json()) as Partial<BackendStatus>;
		if (body.state !== "ready" && body.state !== "starting" && body.state !== "stopped") return { state: "unavailable" };
		return typeof body.retryAfterMs === "number" ? { state: body.state, retryAfterMs: body.retryAfterMs } : { state: body.state };
	} catch {
		return { state: "unavailable" };
	}
}
