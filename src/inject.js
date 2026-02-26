function waitForDiscord(fn) {
	try {
		const US = Vencord.Webpack.findByProps("getUser", "getCurrentUser");
		const CS = Vencord.Webpack.findByProps("getChannel", "getDMFromUserId");
		const GS = Vencord.Webpack.findByProps("getGuild");
		const PS = Vencord.Webpack.findByProps("getStatus", "getState");
		const DS = Vencord.Webpack.findByProps("_currentDispatchActionType");
		if (!US || !CS || !GS || !PS || !DS || !US.getCurrentUser()) {
			throw new Error("not ready");
		}
		fn({ US, CS, GS, PS, DS });
	} catch (e) {
		setTimeout(() => waitForDiscord(fn), 500);
	}
}

waitForDiscord(({ US, CS, GS, PS, DS }) => {
	const me = US.getCurrentUser();
	const CDN = "https://cdn.discordapp.com";

	function getChannelName(channelId) {
		const channel = CS.getChannel(channelId);
		if (!channel) return channelId;
		if (channel.name) return `#${channel.name}`;
		if (channel.recipients?.length) {
			return channel.recipients
				.map((id) => {
					const u = US.getUser(id);
					return u ? u.globalName || u.username : id;
				})
				.join(", ");
		}
		return channelId;
	}

	function getChannelIconUrl(channelId) {
		const channel = CS.getChannel(channelId);
		if (!channel) return null;
		if (channel.guild_id) {
			const guild = GS.getGuild(channel.guild_id);
			if (guild?.icon) return `${CDN}/icons/${guild.id}/${guild.icon}.png?size=64`;
		}
		if (channel.recipients?.length === 1) {
			const u = US.getUser(channel.recipients[0]);
			if (u?.avatar) return `${CDN}/avatars/${u.id}/${u.avatar}.png?size=64`;
			return `${CDN}/embed/avatars/${Number(u?.discriminator ?? 0) % 5}.png`;
		}
		if (channel.icon) return `${CDN}/channel-icons/${channel.id}/${channel.icon}.png?size=64`;
		return null;
	}

	function getUserDisplayName(userId) {
		const u = US.getUser(userId);
		return u ? u.globalName || u.username : userId;
	}

	let previousRings = {};

	function handleCallUpdate(event) {
		if (event.type !== "CALL_UPDATE") return;

		const currentRings = event.ongoingRings ?? {};
		const channel = CS.getChannel(event.channelId);
		const isGroup = channel && (channel.guild_id || (channel.recipients && channel.recipients.length > 1));
		const channelName = getChannelName(event.channelId);
		const iconUrl = getChannelIconUrl(event.channelId);

		for (const [ringerId, ringData] of Object.entries(currentRings)) {
			if (!previousRings[ringerId]) {
				if (ringerId === me.id && PS.getStatus(me.id) !== "dnd") {
					if (window.callBridge) {
						const displayName = isGroup ? channelName : getUserDisplayName(channel.recipients[0]);
						window.callBridge.ringStarted({
							username: displayName,
							iconUrl,
							channelName,
							channelId: event.channelId,
						});
					}
				}
			}
		}

		for (const [ringerId] of Object.entries(previousRings)) {
			if (!currentRings[ringerId]) {
				if (ringerId === me.id && window.callBridge) {
					const callerName = isGroup ? channelName : getUserDisplayName(channel.recipients[0]);
					window.callBridge.ringStopped({ username: callerName, channelName });
				}
			}
		}

		previousRings = currentRings;
	}

	DS.subscribe("CALL_UPDATE", handleCallUpdate);
	console.log(`✅ Subscribed to CALL_UPDATE (logged in as ${me.username})`);

	const { VesktopSettingsIcon } = Vencord.Components;
	const { React } = Vencord.Webpack.Common;
	const { closeAllModals } = Vencord.Webpack.findByProps("closeAllModals");

	Vencord.Plugins.plugins.Settings.customEntries.push({
		key: "recar_settings",
		title: "Recar Settings",
		Icon: VesktopSettingsIcon,
		Component: () => {
			React.useEffect(() => {
				if (window.recarBridge) {
					window.recarBridge.openSettings();
				}
				closeAllModals();
			}, []);
			return null;
		},
	});
});
