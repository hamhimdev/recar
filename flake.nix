{
	description = "Recar - A Discord client for Linux";

	inputs = {
		nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
		flake-utils.url = "github:numtide/flake-utils";
		vencord-src = {
			url = "github:Vendicated/Vencord?ref=refs/tags/v1.14.13";
			flake = false;
		};
		equicord-src = {
			url = "github:Equicord/Equicord?ref=refs/tags/v1.14.13.0";
			flake = false;
		};
		roverpp-src = {
			url = "git+https://git.unium.in/roverpp";
			flake = false;
		};
		dpprpc-src = {
			url = "git+https://git.unium.in/dpprpc";
			flake = false;
		};
	};

	outputs =
		{
			self,
			nixpkgs,
			flake-utils,
			vencord-src,
			equicord-src,
			roverpp-src,
			dpprpc-src,
		}:
		flake-utils.lib.eachDefaultSystem (
			system:
			let
				pkgs = nixpkgs.legacyPackages.${system};
				lib  = nixpkgs.lib;

				roverppSoName =
					if system == "aarch64-linux"
					then "librecar_overlay_arm64.so"
					else "librecar_overlay.so";

				runtimeLibs = with pkgs; [
					pipewire
					libpulseaudio
					stdenv.cc.cc.lib
					fontconfig
					freetype
					libGL
					libwebsockets
				];

				skiaNode = pkgs.stdenv.mkDerivation {
					pname = "skia-canvas-prebuilt";
					version = "3.0.8";

					src = pkgs.fetchurl (
						if system == "aarch64-linux" then {
							url  = "https://github.com/samizdatco/skia-canvas/releases/download/v3.0.8/linux-arm64-glibc.gz";
							hash = "sha256-BmXQemDAXZEqL9FFmus3cU6wRFwveEhAdjhUbD0uGnA=";
						} else {
							url  = "https://github.com/samizdatco/skia-canvas/releases/download/v3.0.8/linux-x64-glibc.gz";
							hash = "sha256-9FklKQWZ1LfLUhHBI/re4nvImddVZpbi4zPQ76xpN7I=";
						}
					);

					dontUnpack = true;
					dontBuild = true;

					installPhase = ''
						mkdir -p $out
						${pkgs.gzip}/bin/gunzip -c $src > $out/skia.node
					'';
				};

				roverpp = pkgs.stdenv.mkDerivation {
					pname = "roverpp";
					version = "0-unstable";
					src = roverpp-src;

					nativeBuildInputs = [
						pkgs.gnumake
						pkgs.python3
						pkgs.glslang
						pkgs.vulkan-headers
						pkgs.vulkan-loader
					];

					buildPhase = ''
						runHook preBuild
						make
						runHook postBuild
					'';

					installPhase = ''
						runHook preInstall

						mkdir -p $out/lib/recar-overlay
						mkdir -p $out/share/vulkan/implicit_layer.d

						cp librecar_overlay.so $out/lib/recar-overlay/

						sed 's|__LIB_PATH__|'"$out"'/lib/recar-overlay/librecar_overlay.so|g' \
							recar_layer.json.in > $out/share/vulkan/implicit_layer.d/recar_layer.json

						runHook postInstall
					'';

					meta = with lib; {
						description = "Vulkan implicit layer for the Recar notification overlay";
						homepage = "https://github.com/TheUnium/roverpp";
						license = licenses.mit;
						platforms = [ "x86_64-linux" "aarch64-linux" ];
					};
				};

				dpprpc = pkgs.stdenv.mkDerivation {
					pname = "dpprpc";
					version = "0-unstable";
					src = dpprpc-src;

					nativeBuildInputs = [ pkgs.gnumake ];

					buildInputs = [
						pkgs.libwebsockets
						pkgs.rapidjson
						pkgs.openssl
					];

					buildPhase = ''
						runHook preBuild
						make
						runHook postBuild
					'';

					installPhase = ''
						runHook preInstall
						mkdir -p $out/bin
						cp bin/dpprpc $out/bin/
						runHook postInstall
					'';

					meta = with lib; {
						description = "Discord Rich Presence for Linux";
						homepage = "https://github.com/TheUnium/dpprpc";
						license = licenses.mit;
						platforms = [ "x86_64-linux" "aarch64-linux" ];
					};
				};

				recar = pkgs.stdenv.mkDerivation rec {
					pname = "recar";
					version = "1.1.23";

					src = pkgs.runCommand "recar-src" { } ''
						mkdir -p $out
						cp -r ${./.}/* $out/
						chmod -R +w $out
						rm -rf $out/vencord $out/equicord $out/roverpp
						cp -r ${vencord-src} $out/vencord
						cp -r ${equicord-src} $out/equicord
						chmod -R +w $out/vencord $out/equicord
					'';

					nativeBuildInputs = [
						pkgs.nodejs
						pkgs.pnpmConfigHook
						pkgs.makeWrapper
						pkgs.pnpm
						pkgs.git
						pkgs.pipewire
						pkgs.autoPatchelfHook
						pkgs.patchelf
					];

					buildInputs = runtimeLibs;

					pnpmDeps = pkgs.fetchPnpmDeps {
						inherit pname version src;
						hash = "sha256-lGtbNbi+iP5RKaROfYuSm/PfiqbhlAUuYwvsADEWfrE=";
						fetcherVersion = 3;
					};

					unpackPhase = ''
						cp -r $src/. .
						chmod -R +w .
					'';

					preBuild = ''
						git init
						git remote add origin https://github.com/hamhimdev/recar

						mkdir -p equicord/.git
						pushd equicord
						git init
						git remote add origin https://github.com/Equicord/Equicord
						git add .
						git -c user.email="nix@build" -c user.name="Nix" commit -m "nix-build-dummy"
						popd

						mkdir -p vencord/.git
						pushd vencord
						git init
						git remote add origin https://github.com/Vendicated/Vencord
						git add .
						git -c user.email="nix@build" -c user.name="Nix" commit -m "nix-build-dummy"
						popd
					'';

					buildPhase = ''
						runHook preBuild

						export VENCORD_REMOTE="Vendicated/Vencord"
						export EQUICORD_REMOTE="Equicord/Equicord"

						pnpm exec tailwindcss -i ./src/input.css -o ./src/tailwind.css --minify

						echo "Building modules..."
						pnpm build:mods

						runHook postBuild
					'';

					installPhase = ''
						runHook preInstall

						mkdir -p $out/share/recar
						cp -r src package.json $out/share/recar/
						cp -r node_modules $out/share/recar/

						# Drop in the prebuilt skia.node (npm install script would normally
						# download this at install time, but Nix blocks network access).
						cp ${skiaNode}/skia.node \
							$out/share/recar/node_modules/.pnpm/skia-canvas@3.0.8/node_modules/skia-canvas/lib/skia.node

						if [ -d "equicord/dist" ]; then
							mkdir -p $out/share/recar/equicord
							cp -r equicord/dist $out/share/recar/equicord/
						fi
						if [ -d "vencord/dist" ]; then
							mkdir -p $out/share/recar/vencord
							cp -r vencord/dist $out/share/recar/vencord/
						fi

						# bundle the native-arch roverpp .so where rcRvInst.js expects it.
						# main.js is at $out/share/recar/src/main.js, so __dirname/..
						# resolves to $out/share/recar - dist/roverpp/ goes there.
						mkdir -p $out/share/recar/dist/roverpp
						cp ${roverpp}/lib/recar-overlay/librecar_overlay.so \
							$out/share/recar/dist/roverpp/${roverppSoName}

						# bundle dpprpc binary
						mkdir -p $out/share/recar/dpprpc/bin
						cp ${dpprpc}/bin/dpprpc $out/share/recar/dpprpc/bin/

						mkdir -p $out/bin
						makeWrapper ${pkgs.electron}/bin/electron $out/bin/recar \
							--add-flags "$out/share/recar/src/main.js" \
							--set NODE_ENV production \
							--prefix PATH : ${lib.makeBinPath [ pkgs.nodejs ]} \
							--prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath runtimeLibs} \
							--add-flags "--no-sandbox"

						mkdir -p $out/share/applications
						cat > $out/share/applications/recar.desktop << EOF
[Desktop Entry]
Name=Recar
Comment=A Discord client for Linux
Exec=recar
Icon=recar
Type=Application
Categories=Network;InstantMessaging;Chat;
Terminal=false
StartupWMClass=Recar
EOF

						mkdir -p $out/share/icons/hicolor/256x256/apps
						if [ -f "src/assets/img/recar.png" ]; then
							cp src/assets/img/recar.png $out/share/icons/hicolor/256x256/apps/recar.png
						fi

						runHook postInstall
					'';

					postFixup = ''
						# autoPatchelfHook may skip .node files that already have a (wrong)
						# RPATH - force-patch all of them so native addons find their libs.
						find $out/share/recar/node_modules -name "*.node" -exec \
							patchelf --set-rpath "${lib.makeLibraryPath runtimeLibs}" {} \;
					'';

					meta = with lib; {
						description = "A Discord client for Linux";
						homepage = "https://recar.loxodrome.app";
						license = licenses.mit;
						platforms = [ "x86_64-linux" "aarch64-linux" ];
						maintainers = [ "hamhim" ];
						mainProgram = "recar";
					};
				};
			in
			{
				packages = {
					inherit recar roverpp dpprpc;
					default = recar;
				};

				devShells.default = pkgs.mkShell {
					buildInputs = [ pkgs.nodejs pkgs.pnpm pkgs.electron ] ++ runtimeLibs;
					LD_LIBRARY_PATH = lib.makeLibraryPath runtimeLibs;
				};
			}
		);
}
