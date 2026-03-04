//PATH=src/plugins/fileUploader_recar/index.tsx
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, showToast, Toasts } from "@webpack/common";
import { CloudUploadIcon } from "@components/Icons";

const logger = new Logger("CatboxUpload");
const CATBOX_API = "https://catbox.moe/user/api.php";

const settings = definePluginSettings({
	userhash: {
		type: OptionType.STRING,
		description: "Your Catbox userhash for account binding (leave empty for anonymous uploads).",
		default: "",
	},
});

async function uploadToCatbox(file: File): Promise<string> {
	const formData = new FormData();
	formData.append("reqtype", "fileupload");
	if (settings.store.userhash) formData.append("userhash", settings.store.userhash);
	formData.append("fileToUpload", file, file.name);

	const response = await fetch(CATBOX_API, { method: "POST", body: formData });
	if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);

	const url = (await response.text()).trim();
	if (!url) throw new Error("Empty response from Catbox");
	return url;
}

async function pickAndUpload() {
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;

	input.onchange = async () => {
		const files = Array.from(input.files ?? []);
		if (!files.length) return;

		showToast(`Uploading ${files.length} file${files.length > 1 ? "s" : ""} to Catbox...`, Toasts.Type.MESSAGE);

		const urls: string[] = [];
		for (const file of files) {
			try {
				urls.push(await uploadToCatbox(file));
			} catch (e) {
				logger.error("Upload failed for", file.name, e);
				showToast(`Failed to upload ${file.name}`, Toasts.Type.FAILURE);
			}
		}

		if (!urls.length) return;
		insertTextIntoChatInputBox(urls.join("\n"));
		showToast(`Uploaded ${urls.length} file${urls.length > 1 ? "s" : ""} to Catbox`, Toasts.Type.SUCCESS);
	};

	input.click();
}

const ctxMenuPatch: NavContextMenuPatchCallback = (children) => {
	children.push(<Menu.MenuItem id="catbox-upload" icon={CloudUploadIcon} label="Upload to Catbox" action={pickAndUpload} />);
};

export default definePlugin({
	name: "CatboxUpload(Recar)",
	description: "Adds an Upload to Catbox option to the attachment menu",
	authors: [
		{
			name: "Clay",
			id: 838197580462293042n,
		},
	],
	settings,

	contextMenus: {
		"channel-attach": ctxMenuPatch,
	},
});
