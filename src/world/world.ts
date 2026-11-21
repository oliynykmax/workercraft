// One Durable Object is one world. It holds every player's TCP connection, so
// "send this to everyone" is a loop over a Map, and it is single-threaded, so
// game logic needs no locks. The changed blocks live in its SQLite storage.

import { DurableObject, RpcTarget } from "cloudflare:workers";
import { wakeBackend, type BackendStatus } from "../backend";
import { bytesToUuid, concat } from "../net/bytes";
import type { Text } from "../net/nbt";
import type { PlayerInfo, Server } from "../plugins/api";
import { SPAWN, builtin } from "../plugins/builtin";
import { PluginHost } from "../plugins/host";
import * as out from "../protocol/packets";
import { AIR, BEFORE_26_3, blockState, data, itemId, itemName, soundId, stackSize } from "../protocol/version";
import { DIRECTIONS, OFFSET, blockOf, type Direction } from "./blockstates";
import {
	applyToSign,
	blankSign,
	facesSignFront,
	interact,
	isSign,
	itemForBlock,
	otherHalf,
	place,
	reshape,
	signLines,
	unsupportedAround,
	type BlockChange,
	type Position,
	type SignData,
} from "./building";
import { BlockStore, MAX_Y, MIN_Y, chunkKey } from "./chunks";
import { ITEM_LIFETIME_TICKS, PICKUP_DELAY_TICKS, canPickUp, stepItem, throwVelocity, type DroppedItem } from "./items";
import { Session, type ClientSettings, type PlayerAction } from "./session";
import { SkinCache } from "./skins";

export interface Env {
	WORLD: DurableObjectNamespace<World>;
	MOTD?: string;
	MAX_PLAYERS?: string;
	VIEW_DISTANCE?: string;
	/** Set to "off" to never call Mojang's profile API. */
	SKINS?: string;
	WAKE_URL?: string;
	WAKE_TOKEN?: string;
	BACKEND_HOST?: string;
	BACKEND_PORT?: string;
}

export interface Player {
	session: Session;
	entityId: number;
	name: string;
	uuid: Uint8Array;
	properties: out.ProfileProperty[];
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	onGround: boolean;
	sneaking: boolean;
	sprinting: boolean;
	skinParts: number;
	viewDistance: number;
	/** Chunks the client currently holds. */
	chunks: Map<number, { cx: number; cz: number }>;
	centerX: number;
	centerZ: number;
	/** Set while the client has not confirmed a teleport; its movement is ignored until then. */
	awaitingTeleport?: number;
	/** What is in each inventory slot. 9 to 35 is the backpack, 36 to 44 the hotbar, 45 the off hand. */
	inventory: Map<number, out.Stack>;
	heldSlot: number;
	/** The item other players currently see in each equipment slot. */
	shown: Map<number, number | undefined>;
	/** The sign whose editor the server opened for this player. */
	editingSign?: Position & { front: boolean };
	lastKeepAlive: number;
	chatAllowance: number;
	chatAllowanceAt: number;
}

export interface WorldStatus {
	online: number;
	max: number;
	players: { name: string; uuid: string }[];
}

/** How long joining waits for a skin before going ahead without it. */
const SKIN_WAIT_MS = 1500;
/** The world flushes queued movement 20 times a second, like a vanilla server's tick. */
const TICK_MS = 50;
const KEEP_ALIVE_INTERVAL_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
/** How far a player may be from a block they break or place. Creative reach is 5. */
const MAX_REACH = 7;
const HORIZONTAL_LIMIT = 30_000_000;
const HOTBAR_FIRST_SLOT = 36;
const OFF_HAND_SLOT = 45;
/** Inventory slots other players can see, and the equipment slot each one shows in. */
const WORN_SLOTS = [
	[5, out.EQUIPMENT_HEAD],
	[6, out.EQUIPMENT_CHEST],
	[7, out.EQUIPMENT_LEGS],
	[8, out.EQUIPMENT_FEET],
	[OFF_HAND_SLOT, out.EQUIPMENT_OFF_HAND],
] as const;
const PLAYER_HALF_WIDTH = 0.3;
const PLAYER_HEIGHT = 1.8;
/** One block change can knock off at most this many others (a tower of sugar cane, say). */
const MAX_CHAIN_REACTION = 1024;
/** Slots a picked-up item may go to: hotbar first, then the backpack. */
const PICKUP_SLOTS = [36, 37, 38, 39, 40, 41, 42, 43, 44, ...Array.from({ length: 27 }, (_, i) => 9 + i)];
const CREATIVE_DROP_SLOT = -1;
/** The oldest items disappear once this many lie around. */
const MAX_DROPPED_ITEMS = 256;
const EYE_HEIGHT = 1.62;
const NOON = 6000;
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1500;

export class World extends DurableObject<Env> {
	private players = new Map<string, Player>();
	private items = new Map<number, DroppedItem>();
	private blocks: BlockStore;
	private skins: SkinCache;
	private plugins: PluginHost;
	private nextEntityId = 1;
	private nextTeleportId = 1;
	private tickTimer?: ReturnType<typeof setInterval>;
	private tickCount = 0;
	/** Things to do on a later tick, such as letting a pressed button out again. */
	private scheduled: { due: number; run: () => void }[] = [];
	private getBlock = (x: number, y: number, z: number): number => this.blocks.getBlock(x, y, z);
	private keepAliveSentAt = 0;
	private maxPlayers: number;
	private maxViewDistance: number;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		this.blocks = new BlockStore(ctx.storage);
		this.skins = new SkinCache(sql);
		sql.exec("CREATE TABLE IF NOT EXISTS players (name TEXT PRIMARY KEY, x REAL, y REAL, z REAL, yaw REAL, pitch REAL)");
		sql.exec("CREATE TABLE IF NOT EXISTS inventories (name TEXT PRIMARY KEY, held INTEGER NOT NULL, slots TEXT NOT NULL)");
		this.maxPlayers = Number(env.MAX_PLAYERS) || 100;
		this.maxViewDistance = Math.min(Math.max(Number(env.VIEW_DISTANCE) || 8, 2), 32);
		this.plugins = new PluginHost([{ name: "builtin", hooks: builtin }], env as unknown as Record<string, unknown>, new ServerApi(this));
	}

	/** Entry point for a player's TCP connection, forwarded by the Worker. */
	async connect(socket: Socket): Promise<void> {
		await new Session(this, socket).run();
	}

	status(): WorldStatus {
		return { online: this.players.size, max: this.maxPlayers, players: this.playerInfos().map(({ name, uuid }) => ({ name, uuid })) };
	}

	/** Starts Paper if necessary and reports whether a transfer can happen yet. */
	backendStatus(): Promise<BackendStatus> {
		return wakeBackend(this.env);
	}

	get backendHost(): string | undefined {
		return this.env.BACKEND_HOST;
	}

	get backendPort(): number {
		const port = Number(this.env.BACKEND_PORT ?? "25565");
		return Number.isInteger(port) && port > 0 && port < 65_536 ? port : 25565;
	}

	get isFull(): boolean {
		return this.players.size >= this.maxPlayers;
	}

	lookupSkin(name: string, claimedUuid: Uint8Array): Promise<out.ProfileProperty[]> {
		if (this.env.SKINS === "off") return Promise.resolve([]);
		return this.skins.lookup(name, claimedUuid).catch(() => []);
	}

	// ---- joining and leaving -------------------------------------------------

	async join(session: Session): Promise<void> {
		// The skin lookup started at login. If Mojang has not answered by now the
		// player joins without one; the answer is still cached for next time.
		const properties = await Promise.race([session.skin, new Promise<[]>((resolve) => setTimeout(() => resolve([]), SKIN_WAIT_MS))]);
		if (session.phase !== "play") return;

		const key = session.name.toLowerCase();
		const existing = this.players.get(key);
		if (existing) {
			existing.session.disconnect({ translate: "multiplayer.disconnect.duplicate_login" });
			this.leave(existing);
		}

		const saved = this.ctx.storage.sql
			.exec<{ x: number; y: number; z: number; yaw: number; pitch: number }>("SELECT x, y, z, yaw, pitch FROM players WHERE name = ?", key)
			.toArray()[0];
		const player: Player = {
			session,
			entityId: this.nextEntityId++,
			name: session.name,
			uuid: session.uuid,
			properties,
			x: saved?.x ?? SPAWN.x,
			y: saved?.y ?? SPAWN.y,
			z: saved?.z ?? SPAWN.z,
			yaw: saved?.yaw ?? 0,
			pitch: saved?.pitch ?? 0,
			onGround: false,
			sneaking: false,
			sprinting: false,
			skinParts: session.settings.skinParts,
			viewDistance: this.clampViewDistance(session.settings.viewDistance),
			chunks: new Map(),
			centerX: NaN,
			centerZ: NaN,
			inventory: new Map(),
			heldSlot: 0,
			shown: new Map(),
			lastKeepAlive: Date.now(),
			chatAllowance: CHAT_BURST,
			chatAllowanceAt: Date.now(),
		};
		this.loadInventory(player);
		for (const [slot, stack] of this.equipmentOf(player)) player.shown.set(slot, stack?.item);
		session.player = player;
		const others = [...this.players.values()];
		this.players.set(key, player);

		player.awaitingTeleport = this.nextTeleportId++;
		session.send(
			concat([
				out.playLogin(player.entityId, this.maxPlayers, player.viewDistance),
				out.creativeAbilities(false),
				...(BEFORE_26_3 ? [] : [out.noPostEffects()]),
				out.fullHealth(),
				out.playerPosition(player.awaitingTeleport, player.x, player.y, player.z, player.yaw, player.pitch),
				// A player entity only shows up for clients that have it in the tab list first.
				out.playerInfoAdd([player, ...others]),
				out.setDefaultSpawn(Math.floor(SPAWN.x), SPAWN.y, Math.floor(SPAWN.z)),
				out.freezeTime(NOON),
				out.tabList({ text: "workercraft", color: "gold", bold: true }, { text: "No server. One Durable Object.", color: "gray" }),
				out.setHeldSlot(player.heldSlot),
				...[...player.inventory].map(([slot, stack]) => out.setInventorySlot(slot, stack.item, stack.count)),
				out.startWaitingForChunks(),
			]),
		);
		this.sendChunks(player);
		for (const other of others) {
			session.send(this.spawnPackets(other));
			other.session.send(concat([out.playerInfoAdd([player]), this.spawnPackets(player)]));
		}
		for (const item of this.items.values()) session.send(out.addItemEntity(item));

		this.broadcast(out.systemChat({ translate: "multiplayer.player.joined", with: [player.name], color: "yellow" }));
		this.tickTimer ??= setInterval(() => this.tick(), TICK_MS);
		void this.plugins.notify("onJoin", { player: info(player) });
	}

	/** Safe to call twice for the same player. */
	leave(player: Player): void {
		const key = player.name.toLowerCase();
		if (this.players.get(key) !== player) return;
		this.players.delete(key);
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO players (name, x, y, z, yaw, pitch) VALUES (?, ?, ?, ?, ?, ?)",
			key,
			player.x,
			player.y,
			player.z,
			player.yaw,
			player.pitch,
		);
		this.saveInventory(player);
		this.broadcast(
			concat([
				out.playerInfoRemove([player.uuid]),
				out.removeEntities([player.entityId]),
				out.systemChat({ translate: "multiplayer.player.left", with: [player.name], color: "yellow" }),
			]),
		);
		if (this.players.size === 0) {
			// Nothing left to do: stop the timer so the object can go idle.
			if (this.tickTimer !== undefined) clearInterval(this.tickTimer);
			this.tickTimer = undefined;
			// Nothing ticks from here on, so whatever was waiting happens now.
			for (const { run } of this.scheduled.splice(0)) run();
			this.blocks.flush();
		}
		void this.plugins.notify("onQuit", { player: info(player) });
	}

	/** Runs 20 times a second, and only while someone is online. */
	private tick(): void {
		this.tickCount++;
		if (this.scheduled.some(({ due }) => due <= this.tickCount)) {
			const due = this.scheduled.filter((task) => task.due <= this.tickCount);
			this.scheduled = this.scheduled.filter((task) => task.due > this.tickCount);
			for (const { run } of due) run();
		}
		this.tickItems();
		for (const player of this.players.values()) player.session.flush();
		const now = Date.now();
		if (now - this.keepAliveSentAt < KEEP_ALIVE_INTERVAL_MS) return;
		this.keepAliveSentAt = now;
		for (const player of [...this.players.values()]) {
			if (now - player.lastKeepAlive > KEEP_ALIVE_TIMEOUT_MS) player.session.disconnect({ translate: "disconnect.timeout" });
			else player.session.send(out.keepAlive(BigInt(now)));
		}
	}

	// ---- dropped items -------------------------------------------------------

	private tickItems(): void {
		const solid = (x: number, y: number, z: number) => this.blocks.getBlock(x, y, z) !== AIR;
		for (const item of this.items.values()) {
			if (stepItem(item, solid)) this.broadcastSoon(out.itemPosition(item, true));
			if (item.age > ITEM_LIFETIME_TICKS || item.y < MIN_Y - 64) this.removeItem(item);
			else if (item.pickupDelay === 0) this.pickUp(item);
		}
	}

	private removeItem(item: DroppedItem): void {
		this.items.delete(item.entityId);
		this.broadcast(out.removeEntities([item.entityId]));
	}

	/** Throws an item out of the player's hands, the way pressing Q does. */
	dropItem(player: Player, item: number, count: number): void {
		const dropped: DroppedItem = {
			entityId: this.nextEntityId++,
			uuid: crypto.getRandomValues(new Uint8Array(16)),
			item,
			count,
			x: player.x,
			y: player.y + EYE_HEIGHT - 0.3,
			z: player.z,
			...throwVelocity(player.yaw, player.pitch),
			age: 0,
			pickupDelay: PICKUP_DELAY_TICKS,
			resting: false,
		};
		this.items.set(dropped.entityId, dropped);
		if (this.items.size > MAX_DROPPED_ITEMS) this.removeItem(this.items.values().next().value!);
		this.broadcast(out.addItemEntity(dropped));
	}

	private pickUp(item: DroppedItem): void {
		for (const player of this.players.values()) {
			if (!canPickUp(item, player)) continue;
			const taken = this.give(player, item.item, item.count);
			if (taken === 0) continue; // inventory full
			this.broadcast(out.takeItem(item.entityId, player.entityId, taken));
			item.count -= taken;
			if (item.count <= 0) this.removeItem(item);
			else this.broadcast(out.itemEntityStack(item.entityId, item.item, item.count));
			return;
		}
	}

	/** Adds items to a player's inventory and returns how many fitted. */
	private give(player: Player, item: number, count: number): number {
		const max = stackSize(item);
		let left = count;
		// Top up stacks of the same item first, then use empty slots.
		for (const topUp of [true, false]) {
			for (const slot of PICKUP_SLOTS) {
				if (left === 0) break;
				const stack = player.inventory.get(slot);
				if (topUp ? stack?.item !== item || stack.count >= max : stack !== undefined) continue;
				const added = Math.min(left, max - (stack?.count ?? 0));
				left -= added;
				this.setSlot(player, slot, item, (stack?.count ?? 0) + added);
			}
		}
		return count - left;
	}

	/** Changes an inventory slot and tells the client. */
	private setSlot(player: Player, slot: number, item: number, count: number): void {
		if (count > 0) player.inventory.set(slot, { item, count });
		else player.inventory.delete(slot);
		player.session.send(out.setInventorySlot(slot, item, count));
		this.syncEquipment(player);
	}

	/** What the player holds and wears, by equipment slot. */
	private equipmentOf(player: Player): [slot: number, stack: out.Stack | undefined][] {
		return [
			[out.EQUIPMENT_MAIN_HAND, player.inventory.get(HOTBAR_FIRST_SLOT + player.heldSlot)],
			...WORN_SLOTS.map(([slot, equipmentSlot]): [number, out.Stack | undefined] => [equipmentSlot, player.inventory.get(slot)]),
		];
	}

	/** Shows other players whatever changed in the player's hands or armour. */
	private syncEquipment(player: Player): void {
		const changed = this.equipmentOf(player).filter(([slot, stack]) => player.shown.get(slot) !== stack?.item);
		if (changed.length === 0) return;
		for (const [slot, stack] of changed) player.shown.set(slot, stack?.item);
		this.broadcast(out.setEquipment(player.entityId, changed), player);
	}

	holdSlot(player: Player, slot: number): void {
		player.heldSlot = slot;
		this.syncEquipment(player);
	}

	/** Items are stored by name, so a saved inventory survives a change of game version. */
	private saveInventory(player: Player): void {
		const slots = [...player.inventory].flatMap(([slot, stack]) => {
			const name = itemName(stack.item);
			return name === undefined ? [] : [[slot, name, stack.count] as const];
		});
		this.ctx.storage.sql.exec("INSERT OR REPLACE INTO inventories (name, held, slots) VALUES (?, ?, ?)", player.name.toLowerCase(), player.heldSlot, JSON.stringify(slots));
	}

	private loadInventory(player: Player): void {
		const saved = this.ctx.storage.sql.exec<{ held: number; slots: string }>("SELECT held, slots FROM inventories WHERE name = ?", player.name.toLowerCase()).toArray()[0];
		if (!saved) return;
		player.heldSlot = saved.held >= 0 && saved.held <= 8 ? saved.held : 0;
		for (const [slot, name, count] of JSON.parse(saved.slots) as [number, string, number][]) {
			const item = itemId(name);
			if (item !== undefined) player.inventory.set(slot, { item, count });
		}
	}

	/** The creative inventory screen telling the server what the player put where. */
	creativeSlot(player: Player, slot: number, item: number, count: number): void {
		const amount = Math.min(count, stackSize(item));
		if (slot === CREATIVE_DROP_SLOT) {
			if (amount > 0) this.dropItem(player, item, amount);
		} else if (slot >= 0 && slot <= OFF_HAND_SLOT) {
			if (amount > 0) player.inventory.set(slot, { item, count: amount });
			else player.inventory.delete(slot);
			this.syncEquipment(player);
		}
	}

	/** Q, Ctrl+Q and F. The client already updated its own inventory the same way. */
	private handAction(player: Player, action: "dropStack" | "dropOne" | "swapHands"): void {
		const heldSlot = HOTBAR_FIRST_SLOT + player.heldSlot;
		const held = player.inventory.get(heldSlot);
		if (action === "swapHands") {
			const offHand = player.inventory.get(OFF_HAND_SLOT);
			if (offHand) player.inventory.set(heldSlot, offHand);
			else player.inventory.delete(heldSlot);
			if (held) player.inventory.set(OFF_HAND_SLOT, held);
			else player.inventory.delete(OFF_HAND_SLOT);
		} else if (held) {
			const count = action === "dropStack" ? held.count : 1;
			held.count -= count;
			if (held.count <= 0) player.inventory.delete(heldSlot);
			this.dropItem(player, held.item, count);
		}
		this.syncEquipment(player);
	}

	// ---- sending -------------------------------------------------------------

	broadcast(bytes: Uint8Array, except?: Player): void {
		for (const player of this.players.values()) if (player !== except) player.session.send(bytes);
	}

	/** Like broadcast, but delivered on the next tick. For high-frequency updates. */
	private broadcastSoon(bytes: Uint8Array, except?: Player): void {
		for (const player of this.players.values()) if (player !== except) player.session.sendSoon(bytes);
	}

	/** Everything another client needs to draw this player. */
	private spawnPackets(player: Player): Uint8Array {
		const equipment = this.equipmentOf(player).filter(([, stack]) => stack !== undefined);
		return concat([
			out.addPlayerEntity(player.entityId, player.uuid, player.x, player.y, player.z, player.yaw, player.pitch),
			out.playerAppearance(player.entityId, player.sneaking, player.sprinting, player.skinParts),
			...(equipment.length > 0 ? [out.setEquipment(player.entityId, equipment)] : []),
		]);
	}

	private clampViewDistance(requested: number): number {
		return Math.min(Math.max(requested, 2), this.maxViewDistance);
	}

	/** Sends the chunks that came into view and drops the ones that left it. */
	private sendChunks(player: Player, force = false): void {
		const cx = Math.floor(player.x) >> 4;
		const cz = Math.floor(player.z) >> 4;
		if (!force && cx === player.centerX && cz === player.centerZ) return;
		player.centerX = cx;
		player.centerZ = cz;

		const radius = player.viewDistance;
		const packets: Uint8Array[] = [out.setChunkCenter(cx, cz)];
		for (const [key, chunk] of player.chunks) {
			if (Math.abs(chunk.cx - cx) > radius + 1 || Math.abs(chunk.cz - cz) > radius + 1) {
				player.chunks.delete(key);
				packets.push(out.forgetChunk(chunk.cx, chunk.cz));
			}
		}

		const missing: { cx: number; cz: number; distance: number }[] = [];
		for (let dx = -radius; dx <= radius; dx++) {
			for (let dz = -radius; dz <= radius; dz++) {
				const distance = dx * dx + dz * dz;
				if (distance > radius * radius + radius) continue; // a disc, not a square
				if (!player.chunks.has(chunkKey(cx + dx, cz + dz))) missing.push({ cx: cx + dx, cz: cz + dz, distance });
			}
		}
		if (missing.length > 0) {
			missing.sort((a, b) => a.distance - b.distance); // nearest first
			packets.push(out.chunkBatchStart());
			for (const chunk of missing) {
				player.chunks.set(chunkKey(chunk.cx, chunk.cz), chunk);
				packets.push(this.blocks.chunkPacket(chunk.cx, chunk.cz));
			}
			packets.push(out.chunkBatchFinished(missing.length));
		}
		player.session.send(concat(packets));
	}

	// ---- movement ------------------------------------------------------------

	move(
		player: Player,
		position: { x: number; y: number; z: number } | undefined,
		rotation: { yaw: number; pitch: number } | undefined,
		onGround: boolean,
	): void {
		if (player.awaitingTeleport !== undefined) return;
		const next = { x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch, ...position, ...rotation };
		const valid =
			[next.x, next.y, next.z, next.yaw, next.pitch].every(Number.isFinite) &&
			Math.abs(next.x) <= HORIZONTAL_LIMIT &&
			Math.abs(next.z) <= HORIZONTAL_LIMIT &&
			Math.abs(next.y) <= 100_000;
		if (!valid) return player.session.disconnect({ translate: "multiplayer.disconnect.invalid_player_movement" });

		const moved = next.x !== player.x || next.y !== player.y || next.z !== player.z;
		const turned = next.yaw !== player.yaw || next.pitch !== player.pitch;
		if (!moved && !turned && onGround === player.onGround) return;
		Object.assign(player, next, { onGround });

		if (player.y < MIN_Y - 64) return this.teleport(player, SPAWN.x, SPAWN.y, SPAWN.z); // fell out of the world
		const packets = [out.entityPosition(player.entityId, player.x, player.y, player.z, player.yaw, player.pitch, onGround)];
		if (turned) packets.push(out.rotateHead(player.entityId, player.yaw));
		this.broadcastSoon(concat(packets), player);
		this.sendChunks(player);
	}

	teleport(player: Player, x: number, y: number, z: number): void {
		Object.assign(player, { x, y, z });
		player.awaitingTeleport = this.nextTeleportId++;
		player.session.send(out.playerPosition(player.awaitingTeleport, x, y, z, player.yaw, player.pitch));
		this.broadcast(out.entityPosition(player.entityId, x, y, z, player.yaw, player.pitch, false), player);
		this.sendChunks(player);
	}

	setPose(player: Player, pose: { sneaking?: boolean; sprinting?: boolean }): void {
		const sneaking = pose.sneaking ?? player.sneaking;
		const sprinting = pose.sprinting ?? player.sprinting;
		if (sneaking === player.sneaking && sprinting === player.sprinting) return;
		Object.assign(player, { sneaking, sprinting });
		this.broadcast(out.playerAppearance(player.entityId, sneaking, sprinting, player.skinParts), player);
	}

	applySettings(player: Player, settings: ClientSettings): void {
		const viewDistance = this.clampViewDistance(settings.viewDistance);
		if (settings.skinParts !== player.skinParts) {
			player.skinParts = settings.skinParts;
			this.broadcast(out.playerAppearance(player.entityId, player.sneaking, player.sprinting, player.skinParts), player);
		}
		if (viewDistance !== player.viewDistance) {
			player.viewDistance = viewDistance;
			this.sendChunks(player, true);
		}
	}

	swing(player: Player, hand: number): void {
		this.broadcastSoon(out.swing(player.entityId, hand), player);
	}

	// ---- chat ----------------------------------------------------------------

	async chat(player: Player, raw: string): Promise<void> {
		const message = raw.trim();
		if (!message) return;
		const now = Date.now();
		player.chatAllowance = Math.min(CHAT_BURST, player.chatAllowance + (now - player.chatAllowanceAt) / CHAT_REFILL_MS);
		player.chatAllowanceAt = now;
		if (player.chatAllowance < 1) return player.session.send(out.systemChat({ text: "You are sending messages too fast.", color: "red" }));
		player.chatAllowance -= 1;

		if (await this.plugins.cancellable("onChat", { player: info(player), message })) return;
		this.broadcast(out.systemChat({ translate: "chat.type.text", with: [player.name, message] }));
	}

	async command(player: Player, line: string): Promise<void> {
		const [command = "", ...args] = line.trim().split(/\s+/);
		const handled = await this.plugins.command({ player: info(player), command: command.toLowerCase(), args });
		if (!handled) player.session.send(out.systemChat({ translate: "command.unknown.command", color: "red" }));
	}

	// ---- blocks --------------------------------------------------------------

	private canReach(player: Player, x: number, y: number, z: number): boolean {
		const dx = x + 0.5 - player.x;
		const dy = y + 0.5 - (player.y + 1.62); // eye height
		const dz = z + 0.5 - player.z;
		return dx * dx + dy * dy + dz * dz <= MAX_REACH * MAX_REACH;
	}

	/** Changes a block and tells every client that has that chunk. */
	changeBlock(x: number, y: number, z: number, state: number, effectsExcept?: Player): boolean {
		const previous = this.blocks.getBlock(x, y, z);
		if (!this.blocks.setBlock(x, y, z, state)) return false;
		const key = chunkKey(x >> 4, z >> 4);
		const update = out.blockUpdate(x, y, z, state);
		const breakEffect = state === AIR ? out.blockBreakEffect(x, y, z, previous) : undefined;
		for (const player of this.players.values()) {
			if (!player.chunks.has(key)) continue;
			player.session.send(update);
			if (breakEffect && player !== effectsExcept) player.session.send(breakEffect);
		}
		return true;
	}

	/** Sends something to every client that has this block's chunk. */
	private sendNear(at: Position, bytes: Uint8Array, except?: Player): void {
		const key = chunkKey(at.x >> 4, at.z >> 4);
		for (const player of this.players.values()) if (player !== except && player.chunks.has(key)) player.session.send(bytes);
	}

	/**
	 * Changes blocks, then lets the surroundings react: fences and stairs take
	 * their new shape, and whatever was attached to a block that is gone falls
	 * off, which can in turn free something else.
	 */
	changeBlocks(changes: BlockChange[], effectsExcept?: Player): void {
		this.settle(changes.filter((change) => this.changeBlock(change.x, change.y, change.z, change.state, effectsExcept)));
	}

	/** Lets the surroundings of blocks that just changed react. */
	private settle(changed: Position[]): void {
		const queue = [...changed];
		for (let next = 0; next < queue.length && next < MAX_CHAIN_REACTION; next++) {
			const at = queue[next]!;
			for (const [dx, dy, dz] of [[0, 0, 0], ...Object.values(OFFSET)] as const) {
				const position = { x: at.x + dx, y: at.y + dy, z: at.z + dz };
				this.changeBlock(position.x, position.y, position.z, reshape(this.getBlock, position));
			}
			for (const loose of unsupportedAround(this.getBlock, at)) queue.push(...this.removeBlock(loose));
		}
	}

	/** Removes a block, and the other half of a door, bed or tall plant with it. Returns what was removed. */
	private removeBlock(at: Position, effectsExcept?: Player): Position[] {
		const state = this.blocks.getBlock(at.x, at.y, at.z);
		const other = otherHalf(state, at);
		const removed = this.changeBlock(at.x, at.y, at.z, AIR, effectsExcept) ? [at] : [];
		if (other && blockOf(this.blocks.getBlock(other.x, other.y, other.z)) === blockOf(state) && this.changeBlock(other.x, other.y, other.z, AIR, effectsExcept)) {
			removed.push(other);
		}
		return removed;
	}

	private playSound(name: string, at: Position, volume?: number, pitch?: number, except?: Player): void {
		const sound = soundId(name);
		if (sound !== undefined) this.sendNear(at, out.blockSound(sound, at.x, at.y, at.z, volume, pitch ?? 0.9 + Math.random() * 0.1), except);
	}

	async dig(player: Player, action: PlayerAction, at: Position, sequence: number): Promise<void> {
		if (action === "dropStack" || action === "dropOne" || action === "swapHands") return this.handAction(player, action);
		if (action !== "startDigging" && action !== "cancelDigging" && action !== "finishDigging") return;
		const { x, y, z } = at;
		// In creative mode a block breaks the moment digging starts.
		if (action === "startDigging") {
			const current = this.blocks.getBlock(x, y, z);
			const allowed =
				current !== AIR &&
				this.canReach(player, x, y, z) &&
				!(await this.plugins.cancellable("onBlockBreak", { player: info(player), x, y, z, block: blockOf(current).name }));
			if (allowed) this.settle(this.removeBlock(at, player));
			else player.session.send(out.blockUpdate(x, y, z, this.blocks.getBlock(x, y, z))); // undo the client's guess
		}
		player.session.send(out.blockChangedAck(sequence));
	}

	/** A right click on a block: use the block, or else place the held one against it. */
	async place(player: Player, hand: number, clicked: Position, face: number, cursor: Position, sequence: number): Promise<void> {
		const direction = DIRECTIONS[face];
		const used = direction !== undefined && this.canReach(player, clicked.x, clicked.y, clicked.z) && (await this.useItemOn(player, hand, clicked, direction, cursor));
		// Until 26.3 the game reported the arm swing of a click itself. Now the
		// server works out that the click did something and tells the others.
		if (used && !BEFORE_26_3) this.swing(player, hand);
		// The client guessed the outcome. Like a vanilla server, always tell it
		// what the two blocks it may have guessed about really are.
		const [dx, dy, dz] = direction ? OFFSET[direction] : [0, 0, 0];
		const beside = { x: clicked.x + dx, y: clicked.y + dy, z: clicked.z + dz };
		player.session.send(
			concat([
				out.blockUpdate(clicked.x, clicked.y, clicked.z, this.blocks.getBlock(clicked.x, clicked.y, clicked.z)),
				out.blockUpdate(beside.x, beside.y, beside.z, this.blocks.getBlock(beside.x, beside.y, beside.z)),
				out.blockChangedAck(sequence),
			]),
		);
	}

	/** Returns whether the click did anything. */
	private async useItemOn(player: Player, hand: number, clicked: Position, face: Direction, cursor: Position): Promise<boolean> {
		const held = player.inventory.get(hand === 0 ? HOTBAR_FIRST_SLOT + player.heldSlot : OFF_HAND_SLOT);
		const heldName = held === undefined ? undefined : itemName(held.item);
		const clickedState = this.blocks.getBlock(clicked.x, clicked.y, clicked.z);

		// Sneaking with something in hand skips the block and uses the item, so
		// that a block can be placed against a door or a chest.
		if (!(player.sneaking && held)) {
			if (isSign(blockOf(clickedState))) {
				this.useSign(player, clicked, clickedState, heldName);
				return true;
			}
			const interaction = interact(this.getBlock, clicked, player.yaw, heldName);
			if (interaction === "nothing") return false;
			if (interaction) {
				const before = interaction.changes.map((change) => ({ ...change, state: this.blocks.getBlock(change.x, change.y, change.z) }));
				this.changeBlocks(interaction.changes);
				if (interaction.sound) this.playSound(interaction.sound, clicked, interaction.volume, interaction.pitch, interaction.soundForActor ? undefined : player);
				if (interaction.revertAfterTicks !== undefined) {
					const { changes, revertSound } = interaction;
					const run = () => {
						// Only what is still the way the click left it goes back.
						const untouched = before.filter((_, index) => this.blocks.getBlock(before[index]!.x, before[index]!.y, before[index]!.z) === changes[index]!.state);
						if (untouched.length === 0) return;
						this.changeBlocks(untouched);
						if (revertSound) this.playSound(revertSound, clicked, interaction.volume, interaction.pitch);
					};
					this.scheduled.push({ due: this.tickCount + interaction.revertAfterTicks, run });
				}
				return true;
			}
		}

		if (heldName === undefined) return false;
		const placement = { getBlock: this.getBlock, item: heldName, clicked, face, cursor, yaw: player.yaw, pitch: player.pitch, minY: MIN_Y, maxY: MAX_Y };
		const planned = place(placement);
		const target = planned?.[0];
		if (!target) return false;
		const block = blockOf(target.state);
		if (block.fullCube && this.isOccupied(target)) return false;
		if (await this.plugins.cancellable("onBlockPlace", { player: info(player), x: target.x, y: target.y, z: target.z, block: block.name })) return false;
		// The plugins took a moment, and the world may have moved on meanwhile.
		const changes = place(placement);
		if (!changes || blockOf(changes[0]!.state) !== block) return false;
		this.changeBlocks(changes);
		// The player's own game already played this; everyone else hears it from here.
		const [placeSound, , volume, pitch] = data.soundGroups[block.soundGroup]!;
		this.sendNear(target, out.blockSound(placeSound, target.x, target.y, target.z, (volume + 1) / 2, pitch * 0.8), player);
		if (isSign(block)) this.openSign(player, changes[0]!, true);
		return true;
	}

	/** Whether a player is standing where this block would go. */
	private isOccupied(at: Position): boolean {
		for (const player of this.players.values()) {
			const overlapsSideways =
				player.x + PLAYER_HALF_WIDTH > at.x && player.x - PLAYER_HALF_WIDTH < at.x + 1 && player.z + PLAYER_HALF_WIDTH > at.z && player.z - PLAYER_HALF_WIDTH < at.z + 1;
			if (overlapsSideways && player.y + PLAYER_HEIGHT > at.y && player.y < at.y + 1 - 1e-6) return true;
		}
		return false;
	}

	// ---- signs ---------------------------------------------------------------

	private signAt(at: Position): SignData {
		return (this.blocks.getBlockData(at.x, at.y, at.z) as SignData | undefined) ?? blankSign();
	}

	private setSign(at: Position, state: number, sign: SignData): void {
		this.blocks.setBlockData(at.x, at.y, at.z, sign);
		const type = blockOf(state).blockEntity;
		if (type !== undefined) this.sendNear(at, out.blockEntityData(at.x, at.y, at.z, type, sign));
	}

	private openSign(player: Player, at: Position, front: boolean): void {
		player.editingSign = { ...at, front };
		player.session.send(out.openSignEditor(at.x, at.y, at.z, front));
	}

	/** A right click on a sign: dye it, wax it, or open it for editing on the side the player is on. */
	private useSign(player: Player, at: Position, state: number, heldName: string | undefined): void {
		const sign = this.signAt(at);
		if (sign.is_waxed) return;
		const front = facesSignFront(state, at, player.x, player.z);
		if (applyToSign(sign, front, heldName)) this.setSign(at, state, sign);
		else this.openSign(player, at, front);
	}

	/** The player closed the sign editor. */
	signUpdate(player: Player, at: Position, front: boolean, lines: string[]): void {
		const editing = player.editingSign;
		player.editingSign = undefined;
		const state = this.blocks.getBlock(at.x, at.y, at.z);
		const expected = editing && editing.x === at.x && editing.y === at.y && editing.z === at.z && editing.front === front;
		if (!expected || !isSign(blockOf(state)) || !this.canReach(player, at.x, at.y, at.z)) return;
		const sign = this.signAt(at);
		if (sign.is_waxed) return;
		(front ? sign.front_text : sign.back_text).messages = signLines(lines);
		this.setSign(at, state, sign);
	}

	/** Middle click: put the block's item in the player's hand. */
	pickBlock(player: Player, at: Position): void {
		const state = this.blocks.getBlock(at.x, at.y, at.z);
		const item = state === AIR ? undefined : itemId(itemForBlock(blockOf(state)));
		if (item === undefined) return;
		const hotbar = Array.from({ length: 9 }, (_, slot) => player.inventory.get(HOTBAR_FIRST_SLOT + slot));
		// Switch to the item if the hotbar has it. Otherwise put it in the hand, or
		// in the first free hotbar slot when the hand is holding something else.
		let slot = hotbar.findIndex((stack) => stack?.item === item);
		if (slot < 0) {
			const free = hotbar.findIndex((stack) => stack === undefined);
			slot = hotbar[player.heldSlot] === undefined || free < 0 ? player.heldSlot : free;
			this.setSlot(player, HOTBAR_FIRST_SLOT + slot, item, 1);
		}
		player.session.send(out.setHeldSlot(slot));
		this.holdSlot(player, slot);
	}

	// ---- for plugins ---------------------------------------------------------

	findPlayer(name: string): Player | undefined {
		return this.players.get(String(name).toLowerCase());
	}

	playerInfos(): PlayerInfo[] {
		return [...this.players.values()].map(info);
	}

	blockAt(x: number, y: number, z: number): number {
		return this.blocks.getBlock(x, y, z);
	}
}

function info(player: Player): PlayerInfo {
	const hex = bytesToUuid(player.uuid);
	return {
		name: player.name,
		uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
		x: player.x,
		y: player.y,
		z: player.z,
	};
}

/**
 * The handle plugins get. It is an RpcTarget, so a plugin running as a separate
 * Worker receives a stub and each call travels back to this Durable Object.
 */
class ServerApi extends RpcTarget implements Server {
	constructor(private world: World) {
		super();
	}

	async broadcast(text: Text): Promise<void> {
		this.world.broadcast(out.systemChat(text));
	}
	async message(player: string, text: Text): Promise<void> {
		this.world.findPlayer(player)?.session.send(out.systemChat(text));
	}
	async players(): Promise<PlayerInfo[]> {
		return this.world.playerInfos();
	}
	async getBlock(x: number, y: number, z: number): Promise<string> {
		return blockOf(this.world.blockAt(Math.floor(x), Math.floor(y), Math.floor(z))).name;
	}
	async setBlock(x: number, y: number, z: number, block: string): Promise<boolean> {
		const state = blockState(String(block));
		const inWorld = [x, y, z].every(Number.isFinite) && Math.abs(x) <= HORIZONTAL_LIMIT && Math.abs(z) <= HORIZONTAL_LIMIT && y >= MIN_Y && y <= MAX_Y;
		if (state === undefined || !inWorld) return false;
		this.world.changeBlocks([{ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), state }]);
		return true;
	}
	async teleport(player: string, x: number, y: number, z: number): Promise<void> {
		const target = this.world.findPlayer(player);
		if (target && [x, y, z].every(Number.isFinite)) this.world.teleport(target, x, y, z);
	}
	async kick(player: string, reason: Text): Promise<void> {
		this.world.findPlayer(player)?.session.disconnect(reason);
	}
}
