// The Worker in front of the world. Spectrum hands it a raw TCP connection.
//
// A server list ping is answered right here: the game shows the server as
// online without anything else running. A player who actually joins is piped
// to the world's Durable Object, which speaks the rest of the protocol.

import { Deframer, Reader, concat } from "./net/bytes";
import type { Text } from "./net/nbt";
import { statusPong, statusResponse } from "./protocol/packets";
import { wakeBackend } from "./backend";
import { PROTOCOL, S, VERSION_NAME } from "./protocol/version";
import type { Env, WorldStatus } from "./world/world";

export { World } from "./world/world";

const INTENT_STATUS = 1;
/** A connection that has not said what it wants by then is dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const LEGACY_PING = 0xfe;

const DEFAULT_MOTD: Text = {
	text: "",
	extra: [
		{ text: "workercraft", color: "gold", bold: true },
		{ text: "  a Minecraft server with no server\n", color: "gray" },
		{ text: "one Durable Object, zero JVMs", color: "dark_gray" },
	],
};

function world(env: Env) {
	return env.WORLD.getByName("main");
}

export default {
	async connect(socket: Socket, env: Env): Promise<void> {
		// A client that drops the connection rejects this; that is not an error here.
		socket.closed.catch(() => {});
		const reader = socket.readable.getReader();
		const deframer = new Deframer(4096);
		const received: Uint8Array[] = [];
		const packets: Uint8Array[] = [];
		const timeout = setTimeout(() => reader.cancel().catch(() => {}), HANDSHAKE_TIMEOUT_MS);

		/** Next packet from the client, or undefined once it hangs up. */
		const nextPacket = async (): Promise<Uint8Array | undefined> => {
			while (packets.length === 0) {
				const { value, done } = await reader.read();
				if (done || value[0] === LEGACY_PING) return undefined; // pre-2013 clients ping differently
				received.push(value);
				packets.push(...deframer.push(value));
			}
			return packets.shift();
		};

		try {
			const handshake = await nextPacket();
			if (!handshake) return;
			const r = new Reader(handshake);
			if (r.varint() !== S.handshake.intention) return;
			r.varint(); // protocol version
			r.string(255); // server address
			r.u16(); // server port
			const intent = r.varint();

			if (intent === INTENT_STATUS) {
				const writer = socket.writable.getWriter();
				for (let packet = await nextPacket(); packet; packet = await nextPacket()) {
					const request = new Reader(packet);
					const id = request.varint();
					if (id === S.status.request) {
						await writer.write(statusResponse(await statusJson(env)));
					} else if (id === S.status.ping) {
						await writer.write(statusPong(request.i64()));
						break;
					}
				}
				await writer.close();
				return;
			}

			// Joining. Hand the connection to the world, replaying what was already read.
			// Do not wait here: the player gets into the tiny lobby while Paper starts.
			void wakeBackend(env);
			clearTimeout(timeout);
			reader.releaseLock();
			const upstream = world(env).connect("world:25565", { allowHalfOpen: true, secureTransport: "off" });
			upstream.closed.catch(() => {});
			await upstream.opened;
			const writer = upstream.writable.getWriter();
			await writer.write(concat(received));
			writer.releaseLock();
			try {
				await Promise.all([socket.readable.pipeTo(upstream.writable), upstream.readable.pipeTo(socket.writable)]);
			} finally {
				await Promise.allSettled([upstream.close()]);
			}
		} catch {
			// A malformed handshake, or one side hung up mid-stream. Either way the
			// connection is over and there is nothing to report.
		} finally {
			clearTimeout(timeout);
			await Promise.allSettled([socket.close()]);
		}
	},

	/** The same Worker over HTTP: who is online, as JSON. */
	async fetch(_request: Request, env: Env): Promise<Response> {
		const status: WorldStatus = await world(env).status();
		return Response.json({ version: VERSION_NAME, protocol: PROTOCOL, ...status });
	},
} satisfies ExportedHandler<Env>;

async function statusJson(env: Env): Promise<unknown> {
	const status: WorldStatus = await world(env).status();
	return {
		version: { name: VERSION_NAME, protocol: PROTOCOL },
		players: { max: status.max, online: status.online, sample: status.players.slice(0, 12).map(({ name, uuid }) => ({ name, id: uuid })) },
		description: env.MOTD ? { text: env.MOTD } : DEFAULT_MOTD,
		enforcesSecureChat: false,
	};
}
