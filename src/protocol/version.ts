// The one place that knows which Minecraft version this server speaks.
// Everything here is read from the file scripts/gen-data.mjs produces.

// "#version-data" is src/generated/v<protocol>.json; wrangler.jsonc and
// tsconfig.json say which one.
import raw from "#version-data";
import type { Nbt } from "../net/nbt";

interface VersionData {
	version: { name: string; protocol: number; sameProtocol: string[] };
	packets: Record<string, { clientbound: Record<string, number>; serverbound: Record<string, number> }>;
	registries: [id: string, entries: string[]][];
	registryData: Record<string, Nbt[]>;
	tags: [registry: string, tags: [name: string, ids: number[]][]][];
	stateCount: number;
	/** One entry per block, ordered by first state id. See world/blockstates.ts. */
	blockDefs: [name: string, first: number, defaultState: number, kind: string, registryId: number, properties: [name: string, values: string[]][], soundGroup: number][];
	/** Block name to block entity type id, for the blocks that have one. */
	blockEntities: Record<string, number>;
	passable: string[];
	fullCubes: string[];
	/** [place sound, break sound, volume, pitch], indexed by a block's sound group. */
	soundGroups: [place: number, breaking: number, volume: number, pitch: number][];
	/** The numbers the protocol uses for the entity data this server sends. */
	entityData: {
		types: { byte: number; pose: number; itemStack: number };
		fields: { flags: number; pose: number; skinParts: number; item: number };
		poses: { standing: number; sneaking: number };
	};
	sounds: Record<string, number>;
	itemBlocks: Record<string, number>;
	itemNames: Record<string, string>;
	stackSizes: Record<string, number>;
	entityTypes: { player: number; item: number };
}

export const data = raw as unknown as VersionData;

export const PROTOCOL = data.version.protocol;
export const VERSION_NAME = data.version.name;

/**
 * True when speaking Minecraft 26.1.x (protocol 775). A handful of packets
 * were laid out differently before 26.3; each place that differs checks this.
 */
export const BEFORE_26_3 = PROTOCOL < 777;

/**
 * Game versions that share this protocol number. The client names its copy of
 * the vanilla data pack after its own version, so each one is offered.
 */
export const DATA_PACK_VERSIONS = [VERSION_NAME, ...data.version.sameProtocol];

function id(state: string, direction: "clientbound" | "serverbound", name: string): number {
	const value = data.packets[state]?.[direction]?.[name];
	if (value === undefined) throw new Error(`Packet ${state}/${direction}/${name} is missing from the generated data`);
	return value;
}
const cb = (state: string, name: string) => id(state, "clientbound", name);
const sb = (state: string, name: string) => id(state, "serverbound", name);
/** For a packet only some versions have: an id no packet has when this one lacks it. */
const optional = (state: string, direction: "clientbound" | "serverbound", name: string) => data.packets[state]?.[direction]?.[name] ?? -1;

/** Clientbound packet ids, by Mojang's packet names. */
export const C = {
	status: { response: cb("status", "status_response"), pong: cb("status", "pong_response") },
	login: { disconnect: cb("login", "login_disconnect"), finished: cb("login", "login_finished") },
	config: {
		customPayload: cb("configuration", "custom_payload"),
		disconnect: cb("configuration", "disconnect"),
		finish: cb("configuration", "finish_configuration"),
		keepAlive: cb("configuration", "keep_alive"),
		registryData: cb("configuration", "registry_data"),
		enabledFeatures: cb("configuration", "update_enabled_features"),
		tags: cb("configuration", "update_tags"),
		knownPacks: cb("configuration", "select_known_packs"),
		transfer: optional("configuration", "clientbound", "transfer"),
	},
	play: {
		addEntity: cb("play", "add_entity"),
		animate: cb("play", "animate"),
		blockChangedAck: cb("play", "block_changed_ack"),
		blockEntityData: cb("play", "block_entity_data"),
		blockUpdate: cb("play", "block_update"),
		chunkBatchFinished: cb("play", "chunk_batch_finished"),
		chunkBatchStart: cb("play", "chunk_batch_start"),
		disconnect: cb("play", "disconnect"),
		entityPositionSync: cb("play", "entity_position_sync"),
		forgetChunk: cb("play", "forget_level_chunk"),
		gameEvent: cb("play", "game_event"),
		keepAlive: cb("play", "keep_alive"),
		levelChunk: cb("play", "level_chunk_with_light"),
		levelEvent: cb("play", "level_event"),
		login: cb("play", "login"),
		openSignEditor: cb("play", "open_sign_editor"),
		playerAbilities: cb("play", "player_abilities"),
		playerInfoRemove: cb("play", "player_info_remove"),
		playerInfoUpdate: cb("play", "player_info_update"),
		playerPosition: cb("play", "player_position"),
		/** Since 26.3. */
		postEffects: optional("play", "clientbound", "post_effects"),
		removeEntities: cb("play", "remove_entities"),
		rotateHead: cb("play", "rotate_head"),
		setChunkCenter: cb("play", "set_chunk_cache_center"),
		setDefaultSpawn: cb("play", "set_default_spawn_position"),
		setEntityData: cb("play", "set_entity_data"),
		setEquipment: cb("play", "set_equipment"),
		setHealth: cb("play", "set_health"),
		containerSetSlot: cb("play", "container_set_slot"),
		takeItemEntity: cb("play", "take_item_entity"),
		setHeldSlot: cb("play", "set_held_slot"),
		setTime: cb("play", "set_time"),
		sound: cb("play", "sound"),
		/** Since 26.3, where it took over from `animate` for arm swings. */
		swingAnimation: optional("play", "clientbound", "swing_animation"),
		systemChat: cb("play", "system_chat"),
		tabList: cb("play", "tab_list"),
		transfer: optional("play", "clientbound", "transfer"),
	},
};

/** Serverbound packet ids. */
export const S = {
	handshake: { intention: sb("handshake", "intention") },
	status: { request: sb("status", "status_request"), ping: sb("status", "ping_request") },
	login: { hello: sb("login", "hello"), acknowledged: sb("login", "login_acknowledged") },
	config: {
		clientInformation: sb("configuration", "client_information"),
		finish: sb("configuration", "finish_configuration"),
		knownPacks: sb("configuration", "select_known_packs"),
	},
	play: {
		acceptTeleportation: sb("play", "accept_teleportation"),
		chat: sb("play", "chat"),
		chatCommand: sb("play", "chat_command"),
		chatCommandSigned: sb("play", "chat_command_signed"),
		clientInformation: sb("play", "client_information"),
		keepAlive: sb("play", "keep_alive"),
		movePos: sb("play", "move_player_pos"),
		pickItemFromBlock: sb("play", "pick_item_from_block"),
		movePosRot: sb("play", "move_player_pos_rot"),
		moveRot: sb("play", "move_player_rot"),
		moveStatusOnly: sb("play", "move_player_status_only"),
		playerAction: sb("play", "player_action"),
		playerCommand: sb("play", "player_command"),
		playerInput: sb("play", "player_input"),
		setCarriedItem: sb("play", "set_carried_item"),
		setCreativeSlot: sb("play", "set_creative_mode_slot"),
		signUpdate: sb("play", "sign_update"),
		/** An arm swing: `swing` until 26.3, `punch` since. */
		swing: optional("play", "serverbound", "swing"),
		punch: optional("play", "serverbound", "punch"),
		useItemOn: sb("play", "use_item_on"),
	},
};

function registryIndex(registry: string, entry: string): number {
	const entries = data.registries.find(([name]) => name === registry)?.[1];
	const index = entries?.indexOf(entry) ?? -1;
	if (index < 0) throw new Error(`${entry} is missing from registry ${registry}`);
	return index;
}

export const DIMENSION = "minecraft:overworld";
export const DIMENSION_TYPE_ID = registryIndex("minecraft:dimension_type", DIMENSION);
export const BIOME_ID = registryIndex("minecraft:worldgen/biome", "minecraft:plains");
export const OVERWORLD_CLOCK_ID = registryIndex("minecraft:world_clock", "minecraft:overworld");
export const PLAYER_ENTITY_TYPE = data.entityTypes.player;
export const ITEM_ENTITY_TYPE = data.entityTypes.item;

/** How many of this item fit in one inventory slot. */
export function stackSize(itemId: number): number {
	return data.stackSizes[String(itemId)] ?? 64;
}

/** Bits needed to write any block state id without a palette. */
export const DIRECT_BLOCK_BITS = Math.ceil(Math.log2(data.stateCount));

export const AIR = 0;

const defaultStates = new Map<string, number>(data.blockDefs.map(([name, , defaultState]) => [name, defaultState]));

/** The default state of a block, by name. */
export function blockState(name: string): number | undefined {
	return defaultStates.get(name.replace(/^minecraft:/, ""));
}

const itemIds = new Map<string, number>(Object.entries(data.itemNames).map(([itemId, name]) => [name, Number(itemId)]));

/** Item name without the namespace, such as "oak_sign". */
export function itemName(itemId: number): string | undefined {
	return data.itemNames[String(itemId)];
}

export function itemId(name: string): number | undefined {
	return itemIds.get(name);
}

export function soundId(name: string): number | undefined {
	return data.sounds[name];
}
