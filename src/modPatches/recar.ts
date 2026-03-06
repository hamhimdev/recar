//PATH=src/plugins/recar/index.ts
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import {
	ChannelStore,
	GuildMemberStore,
	GuildStore,
	PresenceStore,
	React,
	SelectedChannelStore,
	SelectedGuildStore,
	UserStore,
	VoiceStateStore,
} from "@webpack/common";

const CDN = "https://cdn.discordapp.com";

interface VoiceState {
	userId: string;
	channelId?: string | null;
	oldChannelId?: string | null;
	sessionId: string | null | undefined;
	mute: boolean;
	deaf: boolean;
	selfMute: boolean;
	selfDeaf: boolean;
	selfVideo: boolean;
	selfStream: boolean | undefined;
	suppress: boolean;
}

interface UserVoiceInfo {
	userId: string;
	displayName: string;
	avatarUrl: string | null;
	muted: boolean;
	deafened: boolean;
	streaming: boolean;
	video: boolean;
	serverMuted: boolean;
	serverDeafened: boolean;
	suppressed: boolean;
}

function getUserAvatarUrl(
	userId: string,
	guildId: string | null
): string | null {
	const user = UserStore.getUser(userId);
	if (!user) return null;

	if (guildId) {
		const member = GuildMemberStore.getMember(guildId, userId);
		if (member?.avatar)
			return `${CDN}/guilds/${guildId}/users/${userId}/avatars/${member.avatar}.png?size=64`;
	}

	if (user.avatar)
		return `${CDN}/avatars/${user.id}/${user.avatar}.png?size=64`;

	const defaultIndex =
		user.discriminator && user.discriminator !== "0"
			? Number(user.discriminator) % 5
			: Number(BigInt(user.id) >> 22n) % 6;
	return `${CDN}/embed/avatars/${defaultIndex}.png`;
}

function getVoiceInfo(
	state: VoiceState,
	guildId: string | null
): UserVoiceInfo {
	const user = UserStore.getUser(state.userId);
	const nick =
		GuildMemberStore.getNick(guildId!, state.userId) ??
		user?.globalName ??
		user?.username ??
		state.userId;
	return {
		userId: state.userId,
		displayName: nick,
		avatarUrl: getUserAvatarUrl(state.userId, guildId),
		muted: state.selfMute,
		deafened: state.selfDeaf,
		streaming: state.selfStream ?? false,
		video: state.selfVideo,
		serverMuted: state.mute,
		serverDeafened: state.deaf,
		suppressed: state.suppress,
	};
}

// lazy-loaded stores / helpers
const closeAllModals = findByPropsLazy("closeAllModals");

// ---------- helpers ----------

function getChannelName(channelId: string): string {
	const channel = ChannelStore.getChannel(channelId);
	if (!channel) return channelId;
	if (channel.name) return channel.name;
	if (channel.recipients?.length) {
		return channel.recipients
			.map((id: string) => {
				const u = UserStore.getUser(id);
				return u ? u.globalName || u.username : id;
			})
			.join(", ");
	}
	return channelId;
}

function getChannelIconUrl(channelId: string): string | null {
	const channel = ChannelStore.getChannel(channelId);
	if (!channel) return null;

	if (channel.guild_id) {
		const guild = GuildStore.getGuild(channel.guild_id);
		if (guild?.icon)
			return `${CDN}/icons/${guild.id}/${guild.icon}.png?size=64`;
	}

	if (channel.recipients?.length === 1) {
		const u = UserStore.getUser(channel.recipients[0]);
		if (u?.avatar) return `${CDN}/avatars/${u.id}/${u.avatar}.png?size=64`;
		return `${CDN}/embed/avatars/${Number(u?.discriminator ?? 0) % 5}.png`;
	}

	if (channel.icon)
		return `${CDN}/channel-icons/${channel.id}/${channel.icon}.png?size=64`;
	return null;
}

function getUserDisplayName(userId: string): string {
	const u = UserStore.getUser(userId);
	return u ? u.globalName || u.username : userId;
}

interface CurrentUserInfo {
	id: string;
	username: string;
	globalName: string | null;
	discriminator: string;
	avatar: string | null;
	avatarUrl: string | null;
}

function getCurrentUserInfo(): CurrentUserInfo | null {
	const me = UserStore.getCurrentUser();
	if (!me) return null;
	return {
		id: me.id,
		username: me.username,
		globalName: me.globalName ?? null,
		discriminator: me.discriminator ?? "0",
		avatar: me.avatar ?? null,
		avatarUrl: me.avatar
			? `${CDN}/avatars/${me.id}/${me.avatar}.png?size=256`
			: `${CDN}/embed/avatars/${Number(me.discriminator ?? 0) % 5}.png`,
	};
}

function getUsersInMyChannel(): UserVoiceInfo[] {
	const myChanId = SelectedChannelStore.getVoiceChannelId();
	if (!myChanId) return [];

	const myGuildId = SelectedGuildStore.getGuildId();
	const states = VoiceStateStore.getVoiceStatesForChannel(myChanId) as Record<
		string,
		VoiceState
	>;
	return Object.values(states).map((s) => getVoiceInfo(s, myGuildId));
}

// ---------- plugin ----------

let previousRings: Record<string, unknown> = {};
let themeObserver: MutationObserver | null = null;
let origGetDisplayMedia: any = null;

function startThemeObserver() {
	if (document.documentElement) {
		themeObserver = new MutationObserver(() => {
			(window as any).recarBridge?.themeChanged();
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
	} else {
		setTimeout(startThemeObserver, 100);
	}
}

function syncArRPCSettings() {
	try {
		const rpcEnabled: boolean = (window as any).__recarRpcEnabled ?? true;
		const pluginIds = [
			"arRPC.web",
			"WebRichPresence",
			"WebRichPresence (arRPC)",
		];

		for (const id of pluginIds) {
			if (!Vencord.Plugins.plugins[id]) continue;

			Vencord.Settings.plugins[id] ??= {};
			Vencord.Settings.plugins[id].enabled = rpcEnabled;

			if (rpcEnabled && !Vencord.Plugins.isPluginEnabled(id)) {
				Vencord.Plugins.startPlugin(Vencord.Plugins.plugins[id]);
			} else if (!rpcEnabled && Vencord.Plugins.isPluginEnabled(id)) {
				Vencord.Plugins.stopPlugin(Vencord.Plugins.plugins[id]);
			}
		}

		console.log("[Recar] arRPC enabled:", rpcEnabled);
	} catch (e) {
		console.error("[Recar] Failed to update arRPC settings:", e);
	}
}

async function getVirtmicDeviceId() {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const audioDevice = devices.find(
			({ label }) => label === "vencord-screen-share"
		);
		return audioDevice?.deviceId ?? null;
	} catch {
		return null;
	}
}

// Settings entry component - opens Recar settings via the native bridge
function RecarSettingsEntry() {
	React.useEffect(() => {
		if ((window as any).recarBridge) {
			(window as any).recarBridge.openSettings();
		}
		closeAllModals.closeAllModals();
	}, []);
	return null;
}

export default definePlugin({
	name: "Recar",
	description: "Enables some extra features for Recar",
	authors: [
		{
			name: "Clay",
			id: 838197580462293042n,
		},
		{
			name: "hamhim",
			id: 1244223146027122699n,
		},
	],
	required: true,

	flux: {
		CONNECTION_OPEN() {
			// fired when Discord finishes connecting / the user is available
			const info = getCurrentUserInfo();
			if (info) (window as any).recarBridge?.sendUserInfo(info);
		},

		CALL_UPDATE(event: any) {
			const me = UserStore.getCurrentUser();
			if (!me) return;

			const currentRings: Record<string, unknown> =
				event.ongoingRings ?? {};
			const channel = ChannelStore.getChannel(event.channelId);
			const isGroup =
				channel &&
				(channel.guild_id ||
					(channel.recipients && channel.recipients.length > 1));
			const channelName = getChannelName(event.channelId);
			const iconUrl = getChannelIconUrl(event.channelId);

			// New rings - notify if we're the one being rung
			for (const ringerId of Object.keys(currentRings)) {
				if (!previousRings[ringerId]) {
					if (
						ringerId === me.id &&
						!document.hasFocus() &&
						PresenceStore.getStatus(me.id) !== "dnd" &&
						(window as any).callBridge
					) {
						const displayName = isGroup
							? channelName
							: getUserDisplayName(channel.recipients[0]);

						(window as any).callBridge.ringStarted({
							username: displayName,
							iconUrl,
							channelName,
							channelId: event.channelId,
						});
					}
				}
			}

			// Ended rings
			for (const ringerId of Object.keys(previousRings)) {
				if (
					!currentRings[ringerId] &&
					ringerId === me.id &&
					(window as any).callBridge
				) {
					const callerName = isGroup
						? channelName
						: getUserDisplayName(channel.recipients[0]);
					(window as any).callBridge.ringStopped({
						username: callerName,
						channelName,
					});
				}
			}

			previousRings = currentRings;
		},

		RPC_NOTIFICATION_CREATE(notification: any) {
			if ((window as any).statusBridge) {
				const { type: _type, ...notificationData } = notification; // strip flux event type
				(window as any).statusBridge.notification(notificationData);
			}
		},

		VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[] }) {
			const myChanId = SelectedChannelStore.getVoiceChannelId();
			const myGuildId = SelectedGuildStore.getGuildId();

			if (!myChanId) {
				(window as any).statusBridge?.vcUpdate({
					inVoice: false,
					users: [],
				});
				return;
			}

			let changed = false;

			for (const state of voiceStates) {
				const { userId, channelId, oldChannelId } = state;
				if (channelId !== myChanId && oldChannelId !== myChanId)
					continue;

				changed = true;
				const info = getVoiceInfo(state, myGuildId);

				if (channelId === myChanId && oldChannelId !== myChanId) {
					console.log(`[Recar] ➡️ ${info.displayName} joined`, info);
					(window as any).statusBridge?.vcJoin(info);
				} else if (
					oldChannelId === myChanId &&
					channelId !== myChanId
				) {
					console.log(`[Recar] ⬅️ ${info.displayName} left`);
					(window as any).statusBridge?.vcLeave({
						userId,
						displayName: info.displayName,
					});
				} else {
					const flags = [
						info.muted && "muted",
						info.deafened && "deafened",
						info.streaming && "streaming",
						info.video && "video",
						info.serverMuted && "server-muted",
						info.serverDeafened && "server-deafened",
					].filter(Boolean);
					console.log(
						`[Recar] 🔄 ${info.displayName} state changed: [${flags.join(", ") || "none"}]`,
						info
					);
					(window as any).statusBridge?.vcStateChange(info);
				}
			}

			if (changed) {
				const users = getUsersInMyChannel();
				console.log("[Recar] Current VC members:", users);
				(window as any).statusBridge?.vcUpdate({
					inVoice: true,
					users,
				});
			}
		},

		SPEAKING({
			userId,
			channelId,
			speakingFlags,
		}: {
			userId: string;
			channelId: string;
			speakingFlags: number;
		}) {
			const myChanId = SelectedChannelStore.getVoiceChannelId();
			if (!myChanId || channelId !== myChanId) return;

			const isSpeaking = speakingFlags !== 0;
			const myGuildId = SelectedGuildStore.getGuildId();
			const user = UserStore.getUser(userId);
			const displayName =
				GuildMemberStore.getNick(myGuildId!, userId) ??
				user?.globalName ??
				user?.username ??
				userId;
			const avatarUrl = getUserAvatarUrl(userId, myGuildId);

			console.log(
				`[Recar] 🎙️ ${displayName} ${isSpeaking ? "started" : "stopped"} speaking`
			);
			(window as any).statusBridge?.vcSpeaking({
				userId,
				displayName,
				avatarUrl,
				speaking: isSpeaking,
			});
		},
	},

	patches: [
		{
			find: "platform-web",
			replacement: {
				match: '"platform-web"',
				replace: "$self.getPlatformClass()",
			},
		},
		{
			find: '"refresh-title-bar-small"',
			replacement: [
				{
					match: /\i===\i\.PlatformTypes\.WINDOWS/g,
					replace: "((window).__discordTitleBarEnabled)",
				},
				{
					match: /\i===\i\.PlatformTypes\.WEB/g,
					replace: "(!((window).__discordTitleBarEnabled))",
				},
			],
		},
		{
			find: ",setSystemTrayApplications",
			replacement: {
				match: /\i\.window\.(close|minimize|maximize)\(\i\)/g,
				replace: "((window).recarBridge?.$1())",
			},
		},
	],

	start() {
		previousRings = {};

		syncArRPCSettings();
		startThemeObserver();

		// send current user info to main process immediately and on demand
		const sendUserInfo = () => {
			const info = getCurrentUserInfo();
			if (info) (window as any).recarBridge?.sendUserInfo(info);
		};
		sendUserInfo();
		(window as any).recarBridge?.onUserInfoRequested(sendUserInfo);

		// stream stuff
		try {
			if (navigator?.mediaDevices) {
				origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
				navigator.mediaDevices.getDisplayMedia = async function (
					opts: any
				) {
					const stream = await origGetDisplayMedia.call(this, opts);

					if (
						window.recarInternalBridge &&
						typeof window.recarInternalBridge
							.getSyncStreamSettings === "function"
					) {
						const settings =
							window.recarInternalBridge.getSyncStreamSettings();
						if (settings && settings.fps && settings.resolution) {
							const { fps, resolution, contentHint } = settings;
							const width = Math.round(
								resolution.height * (16 / 9)
							);
							const track = stream.getVideoTracks()[0];
							if (track) {
								if (contentHint)
									track.contentHint = contentHint;
								const constraints = {
									...track.getConstraints(),
									frameRate: { min: fps, ideal: fps },
									width: {
										min: 640,
										ideal: width,
										max: width,
									},
									height: {
										min: 480,
										ideal: resolution.height,
										max: resolution.height,
									},
									advanced: [
										{ width, height: resolution.height },
									],
									resizeMode: "none",
								};
								track
									.applyConstraints(constraints)
									.then(() =>
										console.log(
											`[Recar Inject] Applied constraints: ${resolution.height}p @ ${fps}fps`
										)
									)
									.catch((e) =>
										console.error(
											"[Recar Inject] Failed to apply constraints:",
											e
										)
									);
							}
						}
					}

					const virtmicId = await getVirtmicDeviceId();
					if (virtmicId) {
						try {
							const audioStream =
								await navigator.mediaDevices.getUserMedia({
									audio: {
										deviceId: { exact: virtmicId },
										autoGainControl: false,
										echoCancellation: false,
										noiseSuppression: false,
										channelCount: 2,
										sampleRate: 48000,
									},
								});
							stream
								.getAudioTracks()
								.forEach((t) => stream.removeTrack(t));
							stream.addTrack(audioStream.getAudioTracks()[0]);
							console.log("[Recar Inject] Attached virtual mic");
						} catch (e) {
							console.error(
								"[Recar Inject] Failed to attach virtual mic:",
								e
							);
						}
					}

					return stream;
				};
			}
		} catch (e) {
			console.error("[Recar] Failed to override getDisplayMedia:", e);
		}

		// add a settings entry so users can open recar settings from the discord settings ui
		const settingsPlugin = Vencord.Plugins.plugins.Settings as any;
		if (settingsPlugin?.customEntries) {
			settingsPlugin.customEntries.push({
				key: "recar_settings",
				title: "Recar Settings",
				Icon: Vencord.Components.VesktopSettingsIcon,
				Component: RecarSettingsEntry,
			});
		}
	},

	stop() {
		previousRings = {};

		try {
			if (origGetDisplayMedia && navigator?.mediaDevices) {
				navigator.mediaDevices.getDisplayMedia = origGetDisplayMedia;
				origGetDisplayMedia = null;
			}
		} catch (e) {
			console.error("[Recar] Failed to restore getDisplayMedia:", e);
		}

		themeObserver?.disconnect();
		themeObserver = null;

		// remove our custom settings entry
		const settingsPlugin = Vencord.Plugins.plugins.Settings as any;
		if (settingsPlugin?.customEntries) {
			const idx = settingsPlugin.customEntries.findIndex(
				(e: any) => e.key === "recar_settings"
			);
			if (idx !== -1) settingsPlugin.customEntries.splice(idx, 1);
		}
	},

	getPlatformClass() {
		if ((window as any).__discordTitleBarEnabled) return "platform-win";
		return "platform-web";
	},
});
