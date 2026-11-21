// One TCP connection, from handshake to disconnect. Reads packets, keeps the
// protocol phase, and turns play packets into calls on the world.

import { Deframer, ProtocolError, Reader, concat } from "../net/bytes";
import type { Text } from "../net/nbt";
import * as out from "../protocol/packets";
import { BEFORE_26_3, DATA_PACK_VERSIONS, PROTOCOL, S, VERSION_NAME } from "../protocol/version";
import { offlineUuid } from "./skins";
import type { Player, World } from "./world";

export const BRAND = "workercraft";

/** A connection that has not reached the game by then is dropped. */
const LOGIN_TIMEOUT_MS = 20_000;
/** A client that stops reading is dropped once this much is waiting for it. */
const MAX_QUEUED_BYTES = 24 << 20;

/** How long a closing connection waits for its last bytes to go out. */
const FLUSH_TIMEOUT_MS = 2000;

/** What the numbers in a player_action packet mean. 26.3 added one in the middle. */
export type PlayerAction = "startDigging" | "changeDigDirection" | "cancelDigging" | "finishDigging" | "dropStack" | "dropOne" | "releaseItem" | "swapHands" | "stab";
const PLAYER_ACTIONS: PlayerAction[] = BEFORE_26_3
	? ["startDigging", "cancelDigging", "finishDigging", "dropStack", "dropOne", "releaseItem", "swapHands", "stab"]
	: ["startDigging", "changeDigDirection", "cancelDigging", "finishDigging", "dropStack", "dropOne", "releaseItem", "swapHands", "stab"];
const SIGN_FRONT = 1;

const INPUT_SNEAK = 0x20;
const COMMAND_START_SPRINTING = 1;
const COMMAND_STOP_SPRINTING = 2;

export interface ClientSettings {
	viewDistance: number;
	skinParts: number;
}

type Phase = "handshake" | "login" | "config" | "play" | "closed";

export class Session {
	phase: Phase = "handshake";
	name = "";
	uuid: Uint8Array = new Uint8Array(16);
	skin: Promise<out.ProfileProperty[]> = Promise.resolve([]);
	settings: ClientSettings = { viewDistance: 8, skinParts: 0x7f };
	player?: Player;

	private protocol = 0;
	private sentRegistries = false;
	private outbox: Uint8Array[] = [];
	private queuedBytes = 0;
	private lastWrite: Promise<void> = Promise.resolve();
	private backendTimer?: ReturnType<typeof setTimeout>;
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;

	constructor(
		private world: World,
		socket: Socket,
	) {
		// A client that drops the connection rejects this; that is not an error here.
		socket.closed.catch(() => {});
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
		this.reader.closed.catch(() => {});
		this.writer.closed.catch(() => {});
	}

	async run(): Promise<void> {
		const deframer = new Deframer();
		const loginDeadline = setTimeout(() => {
			if (this.phase !== "play") this.close();
		}, LOGIN_TIMEOUT_MS);
		try {
			while (this.phase !== "closed") {
				const { value, done } = await this.reader.read();
				if (done) break;
				for (const data of deframer.push(value)) {
					await this.handle(new Reader(data));
					if ((this.phase as Phase) === "closed") break;
				}
			}
		} catch (error) {
			if (error instanceof ProtocolError) this.disconnect(`Bad packet: ${error.message}`);
			// Anything else is the socket ending abruptly, which is how most clients leave.
		} finally {
			clearTimeout(loginDeadline);
			this.close();
			if (this.backendTimer) clearTimeout(this.backendTimer);
			if (this.player) this.world.leave(this.player);
			await Promise.race([this.lastWrite, new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))]);
		}
	}

	/**
	 * Queues bytes for the world's next tick. Movement of other players goes
	 * through here: with many players it turns thousands of tiny socket writes a
	 * second into one write per player per tick.
	 */
	sendSoon(bytes: Uint8Array): void {
		if (this.phase !== "closed") this.outbox.push(bytes);
	}

	/** Writes whatever sendSoon() queued. */
	flush(): void {
		if (this.outbox.length === 0) return;
		const bytes = this.outbox.length === 1 ? this.outbox[0]! : concat(this.outbox);
		this.outbox = [];
		this.write(bytes);
	}

	/** Sends now, after anything already queued so packets stay in order. */
	send(bytes: Uint8Array): void {
		this.outbox.push(bytes);
		this.flush();
	}

	private write(bytes: Uint8Array): void {
		if (this.phase === "closed") return;
		this.queuedBytes += bytes.length;
		if (this.queuedBytes > MAX_QUEUED_BYTES) {
			this.close();
			return;
		}
		this.lastWrite = this.writer.write(bytes).then(
			() => {
				this.queuedBytes -= bytes.length;
			},
			() => this.close(),
		);
	}

	/** Tells the client why, then closes. */
	disconnect(reason: Text): void {
		if (this.phase === "login" || this.phase === "handshake") this.send(out.loginDisconnect(reason));
		else if (this.phase === "config") this.send(out.configDisconnect(reason));
		else if (this.phase === "play") this.send(out.playDisconnect(reason));
		this.close();
	}

	close(): void {
		if (this.phase === "closed") return;
		this.phase = "closed";
		if (this.backendTimer) clearTimeout(this.backendTimer);
		// Ends the read loop in run(). The socket itself closes when run() returns,
		// which is once everything queued (a disconnect message, say) is written.
		this.reader.cancel().catch(() => {});
	}

	private async handle(r: Reader): Promise<void> {
		const id = r.varint();
		switch (this.phase) {
			case "handshake":
				return this.onHandshake(id, r);
			case "login":
				return this.onLogin(id, r);
			case "config":
				return this.onConfig(id, r);
			case "play":
				return this.onPlay(id, r);
		}
	}

	private onHandshake(id: number, r: Reader): void {
		if (id !== S.handshake.intention) throw new ProtocolError("Expected a handshake");
		this.protocol = r.varint();
		r.string(255); // server address
		r.u16(); // server port
		const intent = r.varint();
		// 1 is a server list ping, which the Worker answers without waking this object.
		if (intent !== 2 && intent !== 3) throw new ProtocolError("Unsupported handshake intent");
		this.phase = "login";
	}

	private async onLogin(id: number, r: Reader): Promise<void> {
		if (id === S.login.hello) {
			const name = r.string(16);
			const claimedUuid = r.bytes(16).slice();
			if (this.protocol !== PROTOCOL) {
				return this.disconnect({ text: `This server runs Minecraft ${VERSION_NAME}. Switch to that version to join.` });
			}
			if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return this.disconnect({ text: "That name is not a valid Minecraft name." });
			if (this.world.isFull) return this.disconnect({ translate: "multiplayer.disconnect.server_full" });
			this.name = name;
			this.uuid = await offlineUuid(name);
			this.skin = this.world.lookupSkin(name, claimedUuid);
			this.send(out.loginFinished(this.uuid, name, []));
		} else if (id === S.login.acknowledged) {
			if (!this.name) throw new ProtocolError("Login acknowledged before login");
			this.phase = "config";
			this.send(out.configPreamble(BRAND));
		}
	}

	private async onConfig(id: number, r: Reader): Promise<void> {
		switch (id) {
			case S.config.clientInformation:
				this.settings = readClientInformation(r);
				return;
			case S.config.knownPacks: {
				if (this.sentRegistries) return;
				this.sentRegistries = true;
				let hasVanillaData = false;
				const count = Math.min(r.varint(), 64);
				for (let i = 0; i < count; i++) {
					const namespace = r.string();
					const pack = r.string();
					const version = r.string();
					if (namespace === "minecraft" && pack === "core" && DATA_PACK_VERSIONS.includes(version)) hasVanillaData = true;
				}
				this.send(out.configRegistries(hasVanillaData));
				return;
			}
			case S.config.finish:
				if (!this.sentRegistries) throw new ProtocolError("Configuration finished early");
				this.phase = "play";
				await this.world.join(this);
				this.watchBackend();
				return;
		}
	}

	/** Keep the player in the micro-world until Paper reports a working RCON connection. */
	private watchBackend(): void {
		const attempt = async () => {
			if (this.phase !== "play") return;
			const backend = await this.world.backendStatus();
			const host = this.world.backendHost;
			if (backend.state === "ready" && host) {
				this.send(out.playTransfer(host, this.world.backendPort));
				return;
			}
			this.backendTimer = setTimeout(attempt, Math.max(1_000, Math.min(backend.retryAfterMs ?? 2_000, 10_000)));
		};
		void attempt();
	}

	private async onPlay(id: number, r: Reader): Promise<void> {
		const player = this.player;
		if (!player) return;
		const world = this.world;
		switch (id) {
			case S.play.keepAlive:
				player.lastKeepAlive = Date.now();
				return;
			case S.play.acceptTeleportation:
				if (r.varint() === player.awaitingTeleport) player.awaitingTeleport = undefined;
				return;
			case S.play.movePos:
				return world.move(player, { x: r.f64(), y: r.f64(), z: r.f64() }, undefined, (r.u8() & 1) !== 0);
			case S.play.movePosRot:
				return world.move(player, { x: r.f64(), y: r.f64(), z: r.f64() }, { yaw: r.f32(), pitch: r.f32() }, (r.u8() & 1) !== 0);
			case S.play.moveRot:
				return world.move(player, undefined, { yaw: r.f32(), pitch: r.f32() }, (r.u8() & 1) !== 0);
			case S.play.moveStatusOnly:
				return world.move(player, undefined, undefined, (r.u8() & 1) !== 0);
			case S.play.chat:
				return world.chat(player, r.string(256));
			case S.play.chatCommand:
			case S.play.chatCommandSigned:
				return world.command(player, r.string(256));
			case S.play.playerAction: {
				const action = PLAYER_ACTIONS[r.varint()];
				const position = r.position();
				r.i8(); // face
				const sequence = r.varint();
				return action === undefined ? undefined : world.dig(player, action, position, sequence);
			}
			case S.play.useItemOn: {
				const hand = r.varint();
				const position = r.position();
				const face = r.varint();
				const cursor = { x: r.f32(), y: r.f32(), z: r.f32() }; // where on the block the crosshair was
				r.bool(), r.bool(); // head inside block, hit the world border
				return world.place(player, hand, position, face, cursor, r.varint());
			}
			case S.play.swing:
				return world.swing(player, r.varint());
			case S.play.punch:
				return world.swing(player, 0);
			case S.play.setCarriedItem: {
				const slot = r.i16();
				if (slot >= 0 && slot <= 8) world.holdSlot(player, slot);
				return;
			}
			case S.play.setCreativeSlot: {
				const slot = r.i16();
				const count = r.varint();
				// Whatever follows the item id (enchantments, names, ...) is not kept.
				return world.creativeSlot(player, slot, count > 0 ? r.varint() : 0, count);
			}
			case S.play.pickItemFromBlock:
				return world.pickBlock(player, r.position());
			case S.play.signUpdate: {
				const position = r.position();
				// The side used to come first, as a yes/no; since 26.3 it comes last.
				const frontFirst = BEFORE_26_3 ? r.bool() : undefined;
				const lines = [r.string(384), r.string(384), r.string(384), r.string(384)];
				return world.signUpdate(player, position, frontFirst ?? r.varint() === SIGN_FRONT, lines);
			}
			case S.play.playerInput:
				return world.setPose(player, { sneaking: (r.u8() & INPUT_SNEAK) !== 0 });
			case S.play.playerCommand: {
				r.varint(); // entity id
				const action = r.varint();
				if (action === COMMAND_START_SPRINTING) world.setPose(player, { sprinting: true });
				else if (action === COMMAND_STOP_SPRINTING) world.setPose(player, { sprinting: false });
				return;
			}
			case S.play.clientInformation:
				this.settings = readClientInformation(r);
				return world.applySettings(player, this.settings);
		}
	}
}

function readClientInformation(r: Reader): ClientSettings {
	r.string(16); // locale
	const viewDistance = r.i8();
	r.varint(); // chat visibility
	r.bool(); // chat colors
	const skinParts = r.u8();
	return { viewDistance, skinParts };
}
