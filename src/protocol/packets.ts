// Builders for every packet the server sends. Field order follows the
// vanilla protocol for the version in ./version.ts.

import { concat, packet, type Writer } from "../net/bytes";
import { writeNbt, type Nbt, type Text } from "../net/nbt";
import { BEFORE_26_3, C, DATA_PACK_VERSIONS, DIMENSION, DIMENSION_TYPE_ID, ITEM_ENTITY_TYPE, OVERWORLD_CLOCK_ID, PLAYER_ENTITY_TYPE, data } from "./version";

export interface ProfileProperty {
	name: string;
	value: string;
	signature?: string;
}

export const GAMEMODE_CREATIVE = 1;

function writeProperties(w: Writer, properties: ProfileProperty[]): void {
	w.varint(properties.length);
	for (const property of properties) {
		w.string(property.name).string(property.value).bool(property.signature !== undefined);
		if (property.signature !== undefined) w.string(property.signature);
	}
}

// ---- status ----------------------------------------------------------------

export const statusResponse = (json: unknown) => packet(C.status.response, (w) => w.string(JSON.stringify(json)));
export const statusPong = (payload: bigint) => packet(C.status.pong, (w) => w.i64(payload));

// ---- login -----------------------------------------------------------------

/** The login phase is the only one that still takes its text as JSON. */
export const loginDisconnect = (reason: Text) => packet(C.login.disconnect, (w) => w.string(JSON.stringify(reason)));

let sessionId: Uint8Array | undefined;

export const loginFinished = (uuid: Uint8Array, name: string, properties: ProfileProperty[]) =>
	packet(C.login.finished, (w) => {
		w.bytes(uuid).string(name);
		writeProperties(w, properties);
		// Since 26.3 the server also names itself with an id that stays the same while it runs.
		if (!BEFORE_26_3) w.bytes((sessionId ??= crypto.getRandomValues(new Uint8Array(16))));
	});

// ---- configuration ---------------------------------------------------------

export const configDisconnect = (reason: Text) => packet(C.config.disconnect, (w) => writeNbt(w, reason as Nbt));

let configPreambleCache: Uint8Array | undefined;

/** Brand, feature flags, and the question "do you already have vanilla's data?". */
export function configPreamble(brand: string): Uint8Array {
	return (configPreambleCache ??= concat([
		packet(C.config.customPayload, (w) => w.string("minecraft:brand").string(brand)),
		packet(C.config.enabledFeatures, (w) => w.varint(1).string("minecraft:vanilla")),
		packet(C.config.knownPacks, (w) => {
			w.varint(DATA_PACK_VERSIONS.length);
			for (const version of DATA_PACK_VERSIONS) w.string("minecraft").string("core").string(version);
		}),
	]));
}

const registryCache: { names?: Uint8Array; full?: Uint8Array } = {};

/**
 * The data registries (biomes, dimension types, damage types, ...), then tags,
 * then "configuration is over".
 *
 * A client that has the vanilla data pack only needs the entry names, which is
 * a few kilobytes. Anything else gets the full contents.
 */
export function configRegistries(clientHasVanillaData: boolean): Uint8Array {
	const key = clientHasVanillaData ? "names" : "full";
	return (registryCache[key] ??= concat([
		...data.registries.map(([registry, entries]) =>
			packet(C.config.registryData, (w) => {
				w.string(registry).varint(entries.length);
				entries.forEach((entry, index) => {
					w.string(entry).bool(!clientHasVanillaData);
					if (!clientHasVanillaData) writeNbt(w, data.registryData[registry]![index]!);
				});
			}),
		),
		packet(C.config.tags, (w) => {
			w.varint(data.tags.length);
			for (const [registry, tags] of data.tags) {
				w.string(registry).varint(tags.length);
				for (const [name, ids] of tags) {
					w.string(name).varint(ids.length);
					for (const entryId of ids) w.varint(entryId);
				}
			}
		}),
		packet(C.config.finish),
	]));
}

// ---- play ------------------------------------------------------------------

export const playDisconnect = (reason: Text) => packet(C.play.disconnect, (w) => writeNbt(w, reason as Nbt));
/** Ask a modern client to open a new connection without making them rejoin manually. */
export const playTransfer = (host: string, port: number) => packet(C.play.transfer, (w) => w.string(host).varint(port));
export const keepAlive = (id: bigint) => packet(C.play.keepAlive, (w) => w.i64(id));

export const playLogin = (entityId: number, maxPlayers: number, viewDistance: number) =>
	packet(C.play.login, (w) => {
		w.i32(entityId).bool(false); // not hardcore
		w.varint(1).string(DIMENSION); // every dimension that exists
		w.varint(maxPlayers).varint(viewDistance).varint(viewDistance); // view and simulation distance
		w.bool(false).bool(true).bool(false); // reduced debug info, respawn screen, limited crafting
		// Where the player spawns.
		w.varint(DIMENSION_TYPE_ID).string(DIMENSION).i64(0n); // hashed seed
		if (BEFORE_26_3) w.i8(GAMEMODE_CREATIVE).i8(-1); // gamemode, no previous gamemode
		else w.varint(GAMEMODE_CREATIVE).varint(0);
		w.bool(false).bool(true); // debug world, flat world
		w.bool(false); // no death location
		w.varint(0).varint(-63); // portal cooldown, sea level
		if (!BEFORE_26_3) w.bool(false); // the server does not verify accounts
		w.bool(false); // chat is not cryptographically signed
	});

const ABILITY_INVULNERABLE = 0x01;
const ABILITY_FLYING = 0x02;
const ABILITY_CAN_FLY = 0x04;
const ABILITY_INSTANT_BREAK = 0x08;

export const creativeAbilities = (flying: boolean) =>
	packet(C.play.playerAbilities, (w) =>
		w
			.i8(ABILITY_INVULNERABLE | ABILITY_CAN_FLY | ABILITY_INSTANT_BREAK | (flying ? ABILITY_FLYING : 0))
			.f32(0.05)
			.f32(0.1),
	);

/** Full health and hunger. Creative players never lose either. */
export const fullHealth = () => packet(C.play.setHealth, (w) => w.f32(20).varint(20).f32(5));

/** Tells the client chunks are on their way, so it can leave the loading screen. */
export const startWaitingForChunks = () => packet(C.play.gameEvent, (w) => w.u8(13).f32(0));

export const setChunkCenter = (cx: number, cz: number) => packet(C.play.setChunkCenter, (w) => w.varint(cx).varint(cz));
/** The packed chunk position is a 64-bit value with z in the high half. */
export const forgetChunk = (cx: number, cz: number) => packet(C.play.forgetChunk, (w) => w.i32(cz).i32(cx));
export const chunkBatchStart = () => packet(C.play.chunkBatchStart);
export const chunkBatchFinished = (count: number) => packet(C.play.chunkBatchFinished, (w) => w.varint(count));

export const playerPosition = (teleportId: number, x: number, y: number, z: number, yaw: number, pitch: number) =>
	packet(C.play.playerPosition, (w) =>
		w.varint(teleportId).f64(x).f64(y).f64(z).f64(0).f64(0).f64(0).f32(yaw).f32(pitch).u32(0), // absolute
	);

export const setDefaultSpawn = (x: number, y: number, z: number) =>
	packet(C.play.setDefaultSpawn, (w) => w.string(DIMENSION).position(x, y, z).f32(0).f32(0));

/** Pins the sky at a fixed time of day (6000 is noon). */
export const freezeTime = (ticks: number) =>
	packet(C.play.setTime, (w) => w.i64(BigInt(ticks)).varint(1).varint(OVERWORLD_CLOCK_ID).varlong(ticks).f32(0).f32(0));

export const tabList = (header: Text, footer: Text) =>
	packet(C.play.tabList, (w) => {
		writeNbt(w, header as Nbt);
		writeNbt(w, footer as Nbt);
	});

export const systemChat = (text: Text, actionBar = false) =>
	packet(C.play.systemChat, (w) => {
		writeNbt(w, text as Nbt);
		w.bool(actionBar);
	});

export interface PlayerListEntry {
	uuid: Uint8Array;
	name: string;
	properties: ProfileProperty[];
}

const INFO_ADD_PLAYER = 0x01;
const INFO_GAME_MODE = 0x04;
const INFO_LISTED = 0x08;
const INFO_LATENCY = 0x10;

/** Adds players to the tab list. A player entity only renders once it is listed. */
export const playerInfoAdd = (entries: PlayerListEntry[]) =>
	packet(C.play.playerInfoUpdate, (w) => {
		w.u8(INFO_ADD_PLAYER | INFO_GAME_MODE | INFO_LISTED | INFO_LATENCY).varint(entries.length);
		for (const entry of entries) {
			w.bytes(entry.uuid).string(entry.name);
			writeProperties(w, entry.properties);
			w.varint(GAMEMODE_CREATIVE).bool(true).varint(0); // gamemode, listed, latency in ms
		}
	});

export const playerInfoRemove = (uuids: Uint8Array[]) =>
	packet(C.play.playerInfoRemove, (w) => {
		w.varint(uuids.length);
		for (const uuid of uuids) w.bytes(uuid);
	});

export const addPlayerEntity = (entityId: number, uuid: Uint8Array, x: number, y: number, z: number, yaw: number, pitch: number) =>
	packet(C.play.addEntity, (w) =>
		w
			.varint(entityId)
			.bytes(uuid)
			.varint(PLAYER_ENTITY_TYPE)
			.f64(x)
			.f64(y)
			.f64(z)
			.u8(0) // velocity: a single zero byte means "not moving"
			.angle(pitch)
			.angle(yaw)
			.angle(yaw) // head yaw
			.varint(0),
	);

export const removeEntities = (entityIds: number[]) =>
	packet(C.play.removeEntities, (w) => {
		w.varint(entityIds.length);
		for (const entityId of entityIds) w.varint(entityId);
	});

/**
 * Where an entity is. Until 26.3 this also carried its velocity; since then it
 * carries a path instead, of which this only ever sends the simplest kind.
 */
function positionSync(entityId: number, x: number, y: number, z: number, yaw: number, pitch: number, onGround: boolean): Uint8Array {
	const PATH_SINGLE_POSITION = 0;
	return packet(C.play.entityPositionSync, (w) => {
		w.varint(entityId);
		if (BEFORE_26_3) w.f64(x).f64(y).f64(z).f64(0).f64(0).f64(0);
		else w.varint(PATH_SINGLE_POSITION).f64(x).f64(y).f64(z);
		w.f32(yaw).f32(pitch).bool(onGround);
	});
}

export const entityPosition = positionSync;

export const rotateHead = (entityId: number, yaw: number) => packet(C.play.rotateHead, (w) => w.varint(entityId).angle(yaw));

/** An entity swinging its arm. `hand` is 0 for the main hand and 1 for the other. */
export function swing(entityId: number, hand: number): Uint8Array {
	if (BEFORE_26_3) {
		const SWING_MAIN_ARM = 0;
		const SWING_OFF_HAND = 3;
		return packet(C.play.animate, (w) => w.varint(entityId).u8(hand === 0 ? SWING_MAIN_ARM : SWING_OFF_HAND));
	}
	const WHACK = 1; // the ordinary swing; the other kind is a spear's stab
	const DURATION_TICKS = 6;
	return packet(C.play.swingAnimation, (w) => w.varint(entityId).varint(hand === 0 ? 0 : 1).varint(WHACK).varint(DURATION_TICKS));
}

/** Screen effects the server asks for: none. A 26.3 server sends this to everyone who joins. */
export const noPostEffects = () => packet(C.play.postEffects, (w) => w.varint(0));

// Entity data fields and value types used below. The numbers differ between
// game versions, so they come from the generated data.
const { flags: META_FLAGS, pose: META_POSE, skinParts: META_SKIN_PARTS, item: META_ITEM_STACK } = data.entityData.fields;
const { byte: META_TYPE_BYTE, pose: META_TYPE_POSE, itemStack: META_TYPE_ITEM_STACK } = data.entityData.types;
const { standing: POSE_STANDING, sneaking: POSE_SNEAKING } = data.entityData.poses;
const FLAG_SNEAKING = 0x02;
const FLAG_SPRINTING = 0x08;

/** How a player looks to others: sneaking, sprinting and which skin layers show. */
export const playerAppearance = (entityId: number, sneaking: boolean, sprinting: boolean, skinParts: number) =>
	packet(C.play.setEntityData, (w) =>
		w
			.varint(entityId)
			.u8(META_FLAGS)
			.varint(META_TYPE_BYTE)
			.u8((sneaking ? FLAG_SNEAKING : 0) | (sprinting ? FLAG_SPRINTING : 0))
			.u8(META_POSE)
			.varint(META_TYPE_POSE)
			.varint(sneaking ? POSE_SNEAKING : POSE_STANDING)
			.u8(META_SKIN_PARTS)
			.varint(META_TYPE_BYTE)
			.u8(skinParts)
			.u8(0xff),
	);

export const blockUpdate = (x: number, y: number, z: number, state: number) =>
	packet(C.play.blockUpdate, (w) => w.position(x, y, z).varint(state));

/** Confirms a block action so the client stops predicting and trusts the server. */
export const blockChangedAck = (sequence: number) => packet(C.play.blockChangedAck, (w) => w.varint(sequence));

const LEVEL_EVENT_BLOCK_BREAK = 2001;

/** Break particles and sound, for everyone except the player who broke it. */
export const blockBreakEffect = (x: number, y: number, z: number, state: number) =>
	packet(C.play.levelEvent, (w) => w.i32(LEVEL_EVENT_BLOCK_BREAK).position(x, y, z).i32(state).bool(false));

/** An item stack: count, then item id and "no extra data" unless the stack is empty. */
function writeItemStack(w: Writer, itemId: number, count: number): void {
	w.varint(count);
	if (count > 0) w.varint(itemId).varint(0).varint(0); // no added or removed components
}

const PLAYER_INVENTORY_WINDOW = 0;

/** Sets a slot of the player's own inventory. Slots 36 to 44 are the hotbar. */
export const setInventorySlot = (slot: number, itemId: number, count: number) =>
	packet(C.play.containerSetSlot, (w) => {
		w.varint(PLAYER_INVENTORY_WINDOW).varint(0).i16(slot); // window, revision, slot
		writeItemStack(w, itemId, count);
	});

/**
 * A velocity in the game's compact form: one zero byte when still, otherwise
 * three 15-bit components sharing a scale, packed into six bytes.
 */
function writeVelocity(w: Writer, x: number, y: number, z: number): void {
	const max = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
	if (!(max >= 3.051944088384301e-5)) {
		w.u8(0);
		return;
	}
	const scale = Math.ceil(max);
	const extended = scale > 3;
	const quantize = (v: number) => Math.round(((v / scale) * 0.5 + 0.5) * 32766);
	const packed = (extended ? (scale % 4) | 4 : scale) + quantize(x) * 0x8 + quantize(y) * 0x40000 + quantize(z) * 0x200000000;
	w.u8(packed % 0x100).u8(Math.floor(packed / 0x100) % 0x100).u32(Math.floor(packed / 0x10000) % 0x100000000);
	if (extended) w.varint(Math.floor(scale / 4));
}

export interface ItemEntityState {
	entityId: number;
	uuid: Uint8Array;
	item: number;
	count: number;
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
}

/** Which item a dropped-item entity shows, and how many. */
export const itemEntityStack = (entityId: number, itemId: number, count: number) =>
	packet(C.play.setEntityData, (w) => {
		w.varint(entityId).u8(META_ITEM_STACK).varint(META_TYPE_ITEM_STACK);
		writeItemStack(w, itemId, count);
		w.u8(0xff);
	});

export const addItemEntity = (e: ItemEntityState) =>
	concat([
		packet(C.play.addEntity, (w) => {
			w.varint(e.entityId).bytes(e.uuid).varint(ITEM_ENTITY_TYPE).f64(e.x).f64(e.y).f64(e.z);
			writeVelocity(w, e.vx, e.vy, e.vz);
			w.u8(0).u8(0).u8(0).varint(0); // pitch, yaw, head yaw, extra data
		}),
		itemEntityStack(e.entityId, e.item, e.count),
	]);

/** Where an item came to rest. */
export const itemPosition = (e: ItemEntityState, onGround: boolean) => positionSync(e.entityId, e.x, e.y, e.z, 0, 0, onGround);

/** The "item flies into the player" animation. The entity still has to be removed. */
export const takeItem = (itemEntityId: number, collectorEntityId: number, count: number) =>
	packet(C.play.takeItemEntity, (w) => w.varint(itemEntityId).varint(collectorEntityId).varint(count));

export const setHeldSlot = (slot: number) => packet(C.play.setHeldSlot, (w) => w.varint(slot));

export interface Stack {
	item: number;
	count: number;
}

export const EQUIPMENT_MAIN_HAND = 0;
export const EQUIPMENT_OFF_HAND = 1;
export const EQUIPMENT_FEET = 2;
export const EQUIPMENT_LEGS = 3;
export const EQUIPMENT_CHEST = 4;
export const EQUIPMENT_HEAD = 5;

/** What other players see an entity holding and wearing. An absent stack empties the slot. */
export const setEquipment = (entityId: number, equipment: [slot: number, stack: Stack | undefined][]) =>
	packet(C.play.setEquipment, (w) => {
		w.varint(entityId);
		equipment.forEach(([slot, stack], index) => {
			w.u8(slot | (index < equipment.length - 1 ? 0x80 : 0)); // the top bit says another entry follows
			writeItemStack(w, stack?.item ?? 0, stack?.count ?? 0);
		});
	});

/** The data of a block entity, such as the text on a sign. */
export const blockEntityData = (x: number, y: number, z: number, type: number, nbt: Nbt) =>
	packet(C.play.blockEntityData, (w) => {
		w.position(x, y, z).varint(type);
		writeNbt(w, nbt);
	});

export const openSignEditor = (x: number, y: number, z: number, front: boolean) =>
	packet(C.play.openSignEditor, (w) => w.position(x, y, z).bool(front));

const SOUND_SOURCE_BLOCKS = 4;

/** Plays one of the game's sounds at the middle of a block. */
export const blockSound = (sound: number, x: number, y: number, z: number, volume = 1, pitch = 1) =>
	packet(C.play.sound, (w) =>
		w
			.varint(sound + 1) // 0 would mean "a custom sound follows"
			.varint(SOUND_SOURCE_BLOCKS)
			.i32(x * 8 + 4) // positions are in eighths of a block
			.i32(y * 8 + 4)
			.i32(z * 8 + 4)
			.f32(volume)
			.f32(pitch)
			.i64(BigInt(Math.floor(Math.random() * 2 ** 32))), // seed for which variation plays
	);
