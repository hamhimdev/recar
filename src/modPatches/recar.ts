//PATH=src/plugins/recar/index.ts
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { UserStore, ChannelStore, GuildStore, PresenceStore, FluxDispatcher, React } from "@webpack/common";

// lazy-loaded stores / helpers
const closeAllModals = findByPropsLazy("closeAllModals");

const CDN = "https://cdn.discordapp.com";

// ---------- helpers ----------

function getChannelName(channelId: string): string {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return channelId;
    if (channel.name) return `#${channel.name}`;
    if (channel.recipients?.length) {
        return channel.recipients
            .map((id: string) => {
                const u = UserStore.getUser(id);
                return u ? (u.globalName || u.username) : id;
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
        if (guild?.icon) return `${CDN}/icons/${guild.id}/${guild.icon}.png?size=64`;
    }

    if (channel.recipients?.length === 1) {
        const u = UserStore.getUser(channel.recipients[0]);
        if (u?.avatar) return `${CDN}/avatars/${u.id}/${u.avatar}.png?size=64`;
        return `${CDN}/embed/avatars/${Number(u?.discriminator ?? 0) % 5}.png`;
    }

    if (channel.icon) return `${CDN}/channel-icons/${channel.id}/${channel.icon}.png?size=64`;
    return null;
}

function getUserDisplayName(userId: string): string {
    const u = UserStore.getUser(userId);
    return u ? (u.globalName || u.username) : userId;
}

// ---------- plugin ----------

let previousRings: Record<string, unknown> = {};
let themeObserver: MutationObserver | null = null;

function handleCallUpdate(event: any) {
    if (event.type !== "CALL_UPDATE") return;

    const me = UserStore.getCurrentUser();
    if (!me) return;

    const currentRings: Record<string, unknown> = event.ongoingRings ?? {};
    const channel = ChannelStore.getChannel(event.channelId);
    const isGroup = channel && (channel.guild_id || (channel.recipients && channel.recipients.length > 1));
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
        if (!currentRings[ringerId] && ringerId === me.id && (window as any).callBridge) {
            const callerName = isGroup
                ? channelName
                : getUserDisplayName(channel.recipients[0]);

            (window as any).callBridge.ringStopped({ username: callerName, channelName });
        }
    }

    previousRings = currentRings;
}

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
        const isEquicord = typeof Equicord !== "undefined";
        const modName = isEquicord ? "EquicordSettings" : "VencordSettings";
        const rpcEnabled: boolean = (window as any).__recarRpcEnabled ?? true;
        const config = JSON.parse(localStorage.getItem(modName) || "{}");
        config.plugins = config.plugins || {};
        ["arRPC.web", "WebRichPresence", "WebRichPresence (arRPC)", "WebContextMenus", "WebScreenShareFixes"].forEach(id => {
            config.plugins[id] = config.plugins[id] || {};
            config.plugins[id].enabled = rpcEnabled;
        });
        localStorage.setItem(modName, JSON.stringify(config));
        console.log("[Recar] arRPC.web enabled:", rpcEnabled, "for", modName);
    } catch (e) {
        console.error("[Recar] Failed to update arRPC settings:", e);
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
            id: 838197580462293042n
        },
        {
            name: "hamhim",
            id: 1244223146027122699n
        }
    ],
    required: true,

    start() {
        previousRings = {};
        FluxDispatcher.subscribe("CALL_UPDATE", handleCallUpdate);

        syncArRPCSettings();
        startThemeObserver();

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
        FluxDispatcher.unsubscribe("CALL_UPDATE", handleCallUpdate);
        previousRings = {};

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
});
